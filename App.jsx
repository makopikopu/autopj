import React, { useState, useEffect, useRef } from "react";
import { Wallet, RefreshCw, Loader2, Settings, ExternalLink, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, Coins } from "lucide-react";
import { storage } from "./storage";

// ---------- design tokens (kept consistent with the perp tracker) ----------

const COLORS = {
  bg: "#0F1218",
  surface: "#171B24",
  surfaceAlt: "#1B2029",
  border: "#262B36",
  text: "#E8EAED",
  textDim: "#8B93A7",
  gold: "#D9A441",
  profit: "#3ECF8E",
  loss: "#F0576B",
};

const CHAINS = {
  eth: { label: "Ethereum", chainId: 1, native: "ETH", explorer: "https://etherscan.io/tx/", color: "#627EEA" },
  bnb: { label: "BNB Chain", chainId: 56, native: "BNB", explorer: "https://bscscan.com/tx/", color: "#F0B90B" },
  sol: { label: "Solana", chainId: null, native: "SOL", explorer: "https://solscan.io/tx/", color: "#14F195" },
};

const STORAGE_TX_KEY = "wallet-ledger:transactions";
const STORAGE_KEYS_KEY = "wallet-ledger:api-keys";
const STORAGE_ADDR_KEY = "wallet-ledger:addresses";

function fmtAmt(n, digits = 6) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("ja-JP", { maximumFractionDigits: digits });
}

function fmtDate(iso) {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

export default function App() {
  const [txs, setTxs] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [etherscanKey, setEtherscanKey] = useState("");
  const [heliusKey, setHeliusKey] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [keyDraft, setKeyDraft] = useState({ etherscan: "", helius: "" });

  const [addresses, setAddresses] = useState({ eth: "", bnb: "", sol: "" });
  const [activeChain, setActiveChain] = useState("eth");
  const [chainFilter, setChainFilter] = useState("all");

  const [fetching, setFetching] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  // ---------- load persisted state ----------
  useEffect(() => {
    (async () => {
      try {
        const t = await storage.get(STORAGE_TX_KEY, false);
        if (t && t.value) {
          const parsed = JSON.parse(t.value);
          if (Array.isArray(parsed)) setTxs(parsed);
        }
      } catch (e) {}
      try {
        const k = await storage.get(STORAGE_KEYS_KEY, false);
        if (k && k.value) {
          const parsed = JSON.parse(k.value);
          setEtherscanKey(parsed.etherscan || "");
          setHeliusKey(parsed.helius || "");
          setKeyDraft({ etherscan: parsed.etherscan || "", helius: parsed.helius || "" });
        }
      } catch (e) {}
      try {
        const a = await storage.get(STORAGE_ADDR_KEY, false);
        if (a && a.value) {
          const parsed = JSON.parse(a.value);
          setAddresses((prev) => ({ ...prev, ...parsed }));
        }
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  const persistTxs = async (next) => {
    try {
      await storage.set(STORAGE_TX_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  const saveKeys = async () => {
    setEtherscanKey(keyDraft.etherscan.trim());
    setHeliusKey(keyDraft.helius.trim());
    setShowKeys(false);
    try {
      await storage.set(
        STORAGE_KEYS_KEY,
        JSON.stringify({ etherscan: keyDraft.etherscan.trim(), helius: keyDraft.helius.trim() }),
        false
      );
    } catch (e) {
      console.error(e);
    }
  };

  const saveAddress = async (chain, value) => {
    const next = { ...addresses, [chain]: value };
    setAddresses(next);
    try {
      await storage.set(STORAGE_ADDR_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  // ---------- fetchers ----------

  const fetchEvm = async (chainKey) => {
    const addr = addresses[chainKey].trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      throw new Error("アドレスの形式が正しくありません(0xで始まる42文字)");
    }
    if (!etherscanKey) throw new Error("Etherscan APIキーが未設定です");
    const chainId = CHAINS[chainKey].chainId;
    const base = "https://api.etherscan.io/v2/api";

    const [nativeRes, tokenRes] = await Promise.all([
      fetch(`${base}?chainid=${chainId}&module=account&action=txlist&address=${addr}&sort=desc&apikey=${etherscanKey}`),
      fetch(`${base}?chainid=${chainId}&module=account&action=tokentx&address=${addr}&sort=desc&apikey=${etherscanKey}`),
    ]);
    if (!nativeRes.ok || !tokenRes.ok) throw new Error(`API error (${nativeRes.status}/${tokenRes.status})`);
    const nativeData = await nativeRes.json();
    const tokenData = await tokenRes.json();

    const mapped = [];
    const native = Array.isArray(nativeData.result) ? nativeData.result : [];
    for (const t of native) {
      const value = Number(t.value) / 1e18;
      if (value === 0) continue; // pure contract calls with no value transfer
      const isSend = t.from?.toLowerCase() === addr.toLowerCase();
      mapped.push({
        id: `${chainKey}-${t.hash}-native`,
        chain: chainKey,
        date: new Date(Number(t.timeStamp) * 1000).toISOString(),
        type: isSend ? "send" : "receive",
        asset: CHAINS[chainKey].native,
        amount: isSend ? -value : value,
        counterparty: isSend ? t.to : t.from,
        txHash: t.hash,
      });
    }
    const tokens = Array.isArray(tokenData.result) ? tokenData.result : [];
    for (const t of tokens) {
      const decimals = Number(t.tokenDecimal) || 18;
      const value = Number(t.value) / Math.pow(10, decimals);
      const isSend = t.from?.toLowerCase() === addr.toLowerCase();
      mapped.push({
        id: `${chainKey}-${t.hash}-${t.contractAddress}-${t.logIndex || ""}`,
        chain: chainKey,
        date: new Date(Number(t.timeStamp) * 1000).toISOString(),
        type: isSend ? "send" : "receive",
        asset: t.tokenSymbol || "?",
        amount: isSend ? -value : value,
        counterparty: isSend ? t.to : t.from,
        txHash: t.hash,
      });
    }
    return mapped;
  };

  const fetchSolana = async () => {
    const addr = addresses.sol.trim();
    if (addr.length < 32 || addr.length > 44) {
      throw new Error("アドレスの形式が正しくないようです");
    }
    if (!heliusKey) throw new Error("Helius APIキーが未設定です");
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${heliusKey}`
    );
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("想定外のレスポンス形式でした");

    const mapped = [];
    for (const t of data) {
      const date = t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null;
      const nativeTransfers = t.nativeTransfers || [];
      const tokenTransfers = t.tokenTransfers || [];

      for (const nt of nativeTransfers) {
        const amountSol = (nt.amount || 0) / 1e9;
        if (amountSol === 0) continue;
        const isSend = nt.fromUserAccount === addr;
        const isReceive = nt.toUserAccount === addr;
        if (!isSend && !isReceive) continue;
        mapped.push({
          id: `sol-${t.signature}-native-${nt.fromUserAccount}-${nt.toUserAccount}`,
          chain: "sol",
          date,
          type: isSend ? "send" : "receive",
          asset: "SOL",
          amount: isSend ? -amountSol : amountSol,
          counterparty: isSend ? nt.toUserAccount : nt.fromUserAccount,
          txHash: t.signature,
        });
      }
      for (const tt of tokenTransfers) {
        const isSend = tt.fromUserAccount === addr;
        const isReceive = tt.toUserAccount === addr;
        if (!isSend && !isReceive) continue;
        mapped.push({
          id: `sol-${t.signature}-${tt.mint}-${tt.fromUserAccount}-${tt.toUserAccount}`,
          chain: "sol",
          date,
          type: isSend ? "send" : "receive",
          asset: tt.tokenSymbol || tt.mint?.slice(0, 4) || "?",
          amount: isSend ? -(tt.tokenAmount || 0) : tt.tokenAmount || 0,
          counterparty: isSend ? tt.toUserAccount : tt.fromUserAccount,
          txHash: t.signature,
        });
      }
    }
    return mapped;
  };

  const handleFetch = async () => {
    setFetching(true);
    setError("");
    setStatus("");
    try {
      let fresh = [];
      if (activeChain === "eth" || activeChain === "bnb") {
        fresh = await fetchEvm(activeChain);
      } else {
        fresh = await fetchSolana();
      }
      setTxs((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const newOnes = fresh.filter((t) => !existingIds.has(t.id));
        const next = [...newOnes, ...prev];
        persistTxs(next);
        setStatus(
          newOnes.length > 0
            ? `${newOnes.length}件の取引を取得しました(合計${fresh.length}件を確認)`
            : "新しい取引はありませんでした(すでに取得済みです)"
        );
        return next;
      });
    } catch (e) {
      console.error(e);
      setError(`取得に失敗しました(${e.message || "unknown error"})。この画面から直接アクセスできない可能性があります。`);
    } finally {
      setFetching(false);
    }
  };

  const filteredTxs = txs
    .filter((t) => chainFilter === "all" || t.chain === chainFilter)
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const typeIcon = (type) => {
    if (type === "send") return <ArrowUpRight size={13} color={COLORS.loss} />;
    if (type === "receive") return <ArrowDownLeft size={13} color={COLORS.profit} />;
    return <ArrowLeftRight size={13} color={COLORS.textDim} />;
  };

  return (
    <div style={styles.page}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
      `}</style>

      <header style={styles.header}>
        <div>
          <div style={styles.eyebrow}>WALLET LEDGER</div>
          <h1 style={styles.title}>マルチチェーン取引トラッカー</h1>
        </div>
        <button
          style={{ ...styles.iconBtn, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 8 }}
          onClick={() => setShowKeys((s) => !s)}
          title="APIキー設定"
        >
          <Settings size={16} color={COLORS.textDim} />
        </button>
      </header>

      {showKeys && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>APIキー設定</div>
          <div style={styles.note}>
            Ethereum・BNB Chainは共通の<strong>Etherscan APIキー</strong>(V2 API、無料枠あり)、Solanaは
            <strong>Helius APIキー</strong>(無料枠あり)を使います。どちらもブラウザに保存されるだけで、サーバーには送信されません。
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Etherscan APIキー(ETH/BNB共通)</label>
            <input
              style={styles.input}
              type="password"
              value={keyDraft.etherscan}
              onChange={(e) => setKeyDraft((s) => ({ ...s, etherscan: e.target.value }))}
              placeholder="発行したAPIキーを貼り付け"
            />
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Helius APIキー(Solana)</label>
            <input
              style={styles.input}
              type="password"
              value={keyDraft.helius}
              onChange={(e) => setKeyDraft((s) => ({ ...s, helius: e.target.value }))}
              placeholder="発行したAPIキーを貼り付け"
            />
          </div>
          <button style={styles.btnPrimary} onClick={saveKeys}>
            保存
          </button>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>ウォレットから取得</div>
        <div style={styles.modeToggle}>
          {Object.entries(CHAINS).map(([key, c]) => (
            <button
              key={key}
              onClick={() => setActiveChain(key)}
              style={{ ...styles.modeBtn, ...(activeChain === key ? styles.modeBtnActive : {}) }}
            >
              {c.label}
            </button>
          ))}
        </div>
        <div style={styles.fieldRow}>
          <input
            style={{ ...styles.input, flex: 1 }}
            value={addresses[activeChain]}
            onChange={(e) => saveAddress(activeChain, e.target.value)}
            placeholder={activeChain === "sol" ? "Solanaアドレス" : "0x… で始まるアドレス"}
          />
          <button style={{ ...styles.btnPrimary, opacity: fetching ? 0.6 : 1 }} disabled={fetching} onClick={handleFetch}>
            {fetching ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
            {fetching ? "取得中…" : "取得"}
          </button>
        </div>
        {error && <div style={styles.errorBanner}>{error}</div>}
        {!fetching && status && <div style={styles.successBanner}>{status}</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.tableHeaderRow}>
          <div style={styles.cardTitle}>取引一覧({filteredTxs.length}件)</div>
          <div style={styles.modeToggle}>
            {["all", "eth", "bnb", "sol"].map((f) => (
              <button
                key={f}
                onClick={() => setChainFilter(f)}
                style={{ ...styles.modeBtn, ...(chainFilter === f ? styles.modeBtnActive : {}) }}
              >
                {f === "all" ? "すべて" : CHAINS[f].label}
              </button>
            ))}
          </div>
        </div>

        {filteredTxs.length === 0 ? (
          <div style={styles.emptyState}>
            まだ取引がありません。上の「取得」からウォレットアドレスを入力してください。
          </div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {["日時", "チェーン", "種別", "銘柄", "数量", "相手アドレス", ""].map((h) => (
                    <th key={h} style={styles.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTxs.slice(0, 300).map((t) => (
                  <tr key={t.id} style={styles.tr}>
                    <td style={styles.td}>{fmtDate(t.date)}</td>
                    <td style={styles.td}>
                      <span style={{ color: CHAINS[t.chain]?.color }}>{CHAINS[t.chain]?.label || t.chain}</span>
                    </td>
                    <td style={styles.td}>
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {typeIcon(t.type)} {t.type === "send" ? "送金" : "受信"}
                      </span>
                    </td>
                    <td style={{ ...styles.td, fontWeight: 600 }}>{t.asset}</td>
                    <td style={{ ...styles.td, color: t.amount >= 0 ? COLORS.profit : COLORS.loss, fontWeight: 700 }}>
                      {t.amount >= 0 ? "+" : ""}
                      {fmtAmt(t.amount)}
                    </td>
                    <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                      {t.counterparty ? `${t.counterparty.slice(0, 6)}...${t.counterparty.slice(-4)}` : "—"}
                    </td>
                    <td style={styles.td}>
                      {CHAINS[t.chain] && t.txHash && (
                        <a href={CHAINS[t.chain].explorer + t.txHash} target="_blank" rel="noreferrer" style={{ color: COLORS.gold }}>
                          <ExternalLink size={13} />
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={styles.footNote}>
        現段階は試作(v1)です:送金・トークン移動の一覧表示までを実装しています。損益計算(総平均法)・DeFi・スワップの詳細判定は次の段階で追加予定です。
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: "100vh",
    background: COLORS.bg,
    color: COLORS.text,
    fontFamily: "'Space Grotesk', sans-serif",
    padding: "20px 16px 60px",
    maxWidth: 980,
    margin: "0 auto",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 18 },
  eyebrow: { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, letterSpacing: 3, color: COLORS.gold, marginBottom: 4 },
  title: { fontSize: 20, fontWeight: 700, margin: 0 },
  card: { background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 18, marginBottom: 16 },
  cardTitle: { fontSize: 14, fontWeight: 600, marginBottom: 12 },
  note: { color: COLORS.textDim, fontSize: 12, lineHeight: 1.6, marginBottom: 10 },
  fieldRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" },
  label: { fontSize: 12, color: COLORS.textDim, minWidth: 180 },
  input: {
    background: COLORS.bg,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 8,
    color: COLORS.text,
    padding: "8px 10px",
    fontSize: 13,
    fontFamily: "'JetBrains Mono', monospace",
    minWidth: 200,
  },
  btnPrimary: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: COLORS.gold,
    color: "#181206",
    border: "none",
    borderRadius: 8,
    padding: "10px 16px",
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
  },
  modeToggle: { display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" },
  modeBtn: {
    background: "transparent",
    color: COLORS.textDim,
    border: `1px solid ${COLORS.border}`,
    borderRadius: 20,
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
  },
  modeBtnActive: { background: COLORS.gold, color: "#181206", borderColor: COLORS.gold, fontWeight: 700 },
  errorBanner: { background: "#2A171C", border: `1px solid ${COLORS.loss}55`, color: "#F5A5B0", padding: "8px 12px", borderRadius: 8, fontSize: 12, marginTop: 8 },
  successBanner: { background: "#152A22", border: `1px solid ${COLORS.profit}55`, color: "#9CE8C4", padding: "8px 12px", borderRadius: 8, fontSize: 12, marginTop: 8 },
  tableHeaderRow: { display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 10 },
  emptyState: { color: COLORS.textDim, fontSize: 13, padding: "24px 0", textAlign: "center" },
  tableWrap: { overflowX: "auto" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12.5, fontFamily: "'JetBrains Mono', monospace" },
  th: { textAlign: "left", padding: "8px 10px", color: COLORS.textDim, fontWeight: 500, borderBottom: `1px solid ${COLORS.border}`, whiteSpace: "nowrap", fontSize: 11 },
  tr: { borderBottom: `1px solid ${COLORS.border}22` },
  td: { padding: "8px 10px", whiteSpace: "nowrap" },
  iconBtn: { background: "transparent", border: "none", cursor: "pointer", padding: 4 },
  footNote: { color: COLORS.textDim, fontSize: 11, textAlign: "center", marginTop: 8, lineHeight: 1.6 },
};

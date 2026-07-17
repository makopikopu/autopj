import React, { useState, useEffect, useRef, useMemo } from "react";
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
  sui: { label: "Sui", chainId: null, native: "SUI", explorer: "https://suiscan.xyz/mainnet/tx/", color: "#4DA2FF" },
};

const SUI_GRAPHQL_ENDPOINT = "https://graphql.mainnet.sui.io/graphql";

function extractCoinSymbol(coinTypeRepr) {
  const parts = coinTypeRepr.split("::");
  return parts[parts.length - 1] || coinTypeRepr;
}

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

  const [addresses, setAddresses] = useState({ eth: [], bnb: [], sol: [], sui: [] });
  const [activeChain, setActiveChain] = useState("eth");
  const [chainFilter, setChainFilter] = useState("all");
  const [walletFilter, setWalletFilter] = useState("all");

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
          // 旧形式({eth: "0x..."} のような単一文字列)を新形式(配列)へ移行
          const migrated = {};
          for (const chain of Object.keys({ eth: [], bnb: [], sol: [], sui: [] })) {
            const v = parsed[chain];
            if (Array.isArray(v)) {
              migrated[chain] = v;
            } else if (typeof v === "string" && v.trim()) {
              migrated[chain] = [{ label: "", address: v.trim() }];
            } else {
              migrated[chain] = [];
            }
          }
          setAddresses(migrated);
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

  const persistAddresses = async (next) => {
    try {
      await storage.set(STORAGE_ADDR_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  const addAddressRow = (chain) => {
    const next = { ...addresses, [chain]: [...addresses[chain], { label: "", address: "" }] };
    setAddresses(next);
    persistAddresses(next);
  };

  const updateAddressRow = (chain, index, field, value) => {
    const next = { ...addresses };
    next[chain] = next[chain].map((row, i) => (i === index ? { ...row, [field]: value } : row));
    setAddresses(next);
    persistAddresses(next);
  };

  const removeAddressRow = (chain, index) => {
    const next = { ...addresses };
    const removed = next[chain][index];
    next[chain] = next[chain].filter((_, i) => i !== index);
    setAddresses(next);
    persistAddresses(next);
    if (removed && walletFilter === removed.address) setWalletFilter("all");
  };

  // ---------- fetchers ----------

  const fetchEvm = async (chainKey, addr) => {
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
        wallet: addr.toLowerCase(),
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
        wallet: addr.toLowerCase(),
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

  const fetchSolana = async (addr) => {
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
          wallet: addr,
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
          wallet: addr,
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

  const fetchSui = async (addr) => {
    if (!/^0x[a-fA-F0-9]{64}$/.test(addr)) {
      throw new Error("アドレスの形式が正しくありません(0xで始まる66文字)");
    }
    const query = `
      query($addr: SuiAddress!, $cursor: String) {
        address(address: $addr) {
          transactions(last: 50, before: $cursor) {
            pageInfo {
              hasPreviousPage
              startCursor
            }
            nodes {
              digest
              effects {
                timestamp
                balanceChanges {
                  nodes {
                    owner { address }
                    coinType { repr }
                    amount
                  }
                }
              }
            }
          }
        }
      }
    `;

    const mapped = [];
    let cursor = null;
    let hasMore = true;
    let page = 0;
    const MAX_PAGES = 40; // 安全のための上限(40 x 50 = 最大2000件まで)

    while (hasMore && page < MAX_PAGES) {
      const res = await fetch(SUI_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: { addr, cursor } }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0]?.message || "GraphQLエラー");

      const txConn = json.data?.address?.transactions;
      const txNodes = txConn?.nodes || [];

      txNodes.forEach((txNode) => {
        const { digest, effects } = txNode;
        const { timestamp, balanceChanges } = effects;
        const changes = balanceChanges?.nodes || [];
        const myChanges = changes.filter(
          (c) => c.owner?.address?.toLowerCase() === addr.toLowerCase()
        );
        const hasOutflow = myChanges.some((c) => BigInt(c.amount) < 0n);
        const hasInflow = myChanges.some((c) => BigInt(c.amount) > 0n);
        const isSwap = hasOutflow && hasInflow && myChanges.length > 1;

        myChanges.forEach((change, idx) => {
          const amountRaw = BigInt(change.amount);
          const symbol = extractCoinSymbol(change.coinType.repr);
          const decimals = 9; // 暫定:SUI以外は桁数が異なる可能性あり(要調整)
          const value = Number(amountRaw) / Math.pow(10, decimals);

          mapped.push({
            id: `sui-${digest}-${idx}`,
            chain: "sui",
            wallet: addr.toLowerCase(),
            date: timestamp,
            type: isSwap ? "swap" : value > 0 ? "receive" : "send",
            asset: symbol,
            amount: value,
            counterparty: null,
            txHash: digest,
          });
        });
      });

      hasMore = !!txConn?.pageInfo?.hasPreviousPage;
      cursor = txConn?.pageInfo?.startCursor || null;
      page += 1;
      if (!cursor) hasMore = false;
    }

    return mapped;
  };

  const fetchForAddress = async (chainKey, addr) => {
    if (chainKey === "eth" || chainKey === "bnb") return fetchEvm(chainKey, addr);
    if (chainKey === "sol") return fetchSolana(addr);
    if (chainKey === "sui") return fetchSui(addr);
    return [];
  };

  // 1つのウォレットアドレスだけ取得
  const handleFetchOne = async (chainKey, addr) => {
    const trimmed = (addr || "").trim();
    if (!trimmed) {
      setError("アドレスが入力されていません");
      return;
    }
    setFetching(true);
    setError("");
    setStatus("");
    try {
      const fresh = await fetchForAddress(chainKey, trimmed);
      let result = { newOnesCount: 0, total: 0 };
      setTxs((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const newOnes = fresh.filter((t) => !existingIds.has(t.id));
        const next = [...newOnes, ...prev];
        persistTxs(next);
        result = { newOnesCount: newOnes.length, total: fresh.length };
        return next;
      });
      setStatus(
        result.newOnesCount > 0
          ? `${result.newOnesCount}件の取引を取得しました(合計${result.total}件を確認)`
          : "新しい取引はありませんでした(すでに取得済みです)"
      );
    } catch (e) {
      console.error(e);
      setError(`取得に失敗しました(${e.message || "unknown error"})。この画面から直接アクセスできない可能性があります。`);
    } finally {
      setFetching(false);
    }
  };

  // アクティブなチェーンに登録されている全ウォレットアドレスをまとめて取得
  const handleFetchAllForChain = async () => {
    const rows = (addresses[activeChain] || []).filter((r) => r.address.trim());
    if (rows.length === 0) {
      setError("このチェーンにはアドレスが登録されていません");
      return;
    }
    setFetching(true);
    setError("");
    setStatus("");
    let totalNew = 0;
    let totalSeen = 0;
    const failedLabels = [];
    try {
      for (const row of rows) {
        try {
          const fresh = await fetchForAddress(activeChain, row.address.trim());
          setTxs((prev) => {
            const existingIds = new Set(prev.map((t) => t.id));
            const newOnes = fresh.filter((t) => !existingIds.has(t.id));
            const next = [...newOnes, ...prev];
            persistTxs(next);
            totalNew += newOnes.length;
            totalSeen += fresh.length;
            return next;
          });
        } catch (e) {
          console.error(e);
          failedLabels.push(row.label || row.address.slice(0, 8));
        }
      }
      if (failedLabels.length > 0) {
        setError(`一部のアドレスで取得に失敗しました: ${failedLabels.join(", ")}`);
      }
      setStatus(
        totalNew > 0
          ? `${totalNew}件の取引を取得しました(合計${totalSeen}件を確認、${rows.length}アドレス分)`
          : "新しい取引はありませんでした(すでに取得済みです)"
      );
    } finally {
      setFetching(false);
    }
  };

  const chainWallets = addresses[chainFilter === "all" ? activeChain : chainFilter] || [];

  const filteredTxs = useMemo(() => {
    return txs
      .filter((t) => chainFilter === "all" || t.chain === chainFilter)
      .filter((t) => walletFilter === "all" || t.wallet?.toLowerCase() === walletFilter.toLowerCase())
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }, [txs, chainFilter, walletFilter]);

  const [visibleCount, setVisibleCount] = useState(100);
  useEffect(() => {
    setVisibleCount(100);
  }, [chainFilter, walletFilter]);

  const walletLabel = (chain, addr) => {
    const row = (addresses[chain] || []).find((r) => r.address.toLowerCase() === (addr || "").toLowerCase());
    if (row && row.label) return row.label;
    return addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : "—";
  };

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
            Suiは公式GraphQLエンドポイントを直接使うため、APIキーは不要です。
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

        {(addresses[activeChain] || []).map((row, idx) => (
          <div style={styles.fieldRow} key={idx}>
            <input
              style={{ ...styles.input, width: 110 }}
              value={row.label}
              onChange={(e) => updateAddressRow(activeChain, idx, "label", e.target.value)}
              placeholder="ラベル(任意)"
            />
            <input
              style={{ ...styles.input, flex: 1 }}
              value={row.address}
              onChange={(e) => updateAddressRow(activeChain, idx, "address", e.target.value)}
              placeholder={
                activeChain === "sol"
                  ? "Solanaアドレス"
                  : activeChain === "sui"
                  ? "0x… で始まるアドレス(66文字)"
                  : "0x… で始まるアドレス"
              }
            />
            <button
              style={{ ...styles.btnPrimary, opacity: fetching ? 0.6 : 1, padding: "10px 12px" }}
              disabled={fetching}
              onClick={() => handleFetchOne(activeChain, row.address)}
              title="このアドレスだけ取得"
            >
              {fetching ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
            </button>
            <button
              style={{ ...styles.iconBtn, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 10 }}
              onClick={() => removeAddressRow(activeChain, idx)}
              title="削除"
            >
              <span style={{ color: COLORS.loss, fontSize: 13 }}>✕</span>
            </button>
          </div>
        ))}

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <button
            style={{ ...styles.modeBtn }}
            onClick={() => addAddressRow(activeChain)}
          >
            + アドレスを追加
          </button>
          <button
            style={{ ...styles.btnPrimary, opacity: fetching ? 0.6 : 1 }}
            disabled={fetching}
            onClick={handleFetchAllForChain}
          >
            {fetching ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
            {fetching ? "取得中…" : `${CHAINS[activeChain].label}を全て取得`}
          </button>
        </div>

        {error && <div style={styles.errorBanner}>{error}</div>}
        {!fetching && status && <div style={styles.successBanner}>{status}</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.tableHeaderRow}>
          <div style={styles.cardTitle}>取引一覧({filteredTxs.length}件)</div>
          <div style={styles.modeToggle}>
            {["all", "eth", "bnb", "sol", "sui"].map((f) => (
              <button
                key={f}
                onClick={() => {
                  setChainFilter(f);
                  setWalletFilter("all");
                }}
                style={{ ...styles.modeBtn, ...(chainFilter === f ? styles.modeBtnActive : {}) }}
              >
                {f === "all" ? "すべて" : CHAINS[f].label}
              </button>
            ))}
          </div>
        </div>

        {chainFilter !== "all" && (addresses[chainFilter] || []).filter((r) => r.address.trim()).length > 1 && (
          <div style={{ ...styles.modeToggle, marginTop: -4 }}>
            <button
              onClick={() => setWalletFilter("all")}
              style={{ ...styles.modeBtn, ...(walletFilter === "all" ? styles.modeBtnActive : {}) }}
            >
              全ウォレット
            </button>
            {(addresses[chainFilter] || [])
              .filter((r) => r.address.trim())
              .map((r) => (
                <button
                  key={r.address}
                  onClick={() => setWalletFilter(r.address)}
                  style={{ ...styles.modeBtn, ...(walletFilter === r.address ? styles.modeBtnActive : {}) }}
                >
                  {r.label || `${r.address.slice(0, 6)}...${r.address.slice(-4)}`}
                </button>
              ))}
          </div>
        )}

        {filteredTxs.length === 0 ? (
          <div style={styles.emptyState}>
            まだ取引がありません。上の「取得」からウォレットアドレスを入力してください。
          </div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {["日時", "チェーン", "ウォレット", "種別", "銘柄", "数量", "相手アドレス", ""].map((h) => (
                    <th key={h} style={styles.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTxs.slice(0, visibleCount).map((t) => (
                  <tr key={t.id} style={styles.tr}>
                    <td style={styles.td}>{fmtDate(t.date)}</td>
                    <td style={styles.td}>
                      <span style={{ color: CHAINS[t.chain]?.color }}>{CHAINS[t.chain]?.label || t.chain}</span>
                    </td>
                    <td style={{ ...styles.td, fontSize: 11, color: COLORS.textDim }}>
                      {walletLabel(t.chain, t.wallet)}
                    </td>
                    <td style={styles.td}>
                      <span style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {typeIcon(t.type)} {t.type === "send" ? "送金" : t.type === "swap" ? "スワップ" : "受信"}
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
        {filteredTxs.length > visibleCount && (
          <button
            style={{ ...styles.modeBtn, marginTop: 12, width: "100%", textAlign: "center" }}
            onClick={() => setVisibleCount((c) => c + 100)}
          >
            もっと見る(あと{filteredTxs.length - visibleCount}件)
          </button>
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

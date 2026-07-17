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
  if (n === null || n === undefined || Number.isNaN(n)) return "窶�";
  return Number(n).toLocaleString("ja-JP", { maximumFractionDigits: digits });
}

function fmtDate(iso) {
  if (!iso) return "窶�";
  return iso.slice(0, 16).replace("T", " ");
}

export default function App() {
  const [txs, setTxs] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [etherscanKey, setEtherscanKey] = useState("");
  const [heliusKey, setHeliusKey] = useState("");
  const [showKeys, setShowKeys] = useState(false);
  const [keyDraft, setKeyDraft] = useState({ etherscan: "", helius: "" });

  const [addresses, setAddresses] = useState({ eth: "", bnb: "", sol: "", sui: "" });
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
      throw new Error("繧｢繝峨Ξ繧ｹ縺ｮ蠖｢蠑上′豁｣縺励￥縺ゅｊ縺ｾ縺帙ｓ(0x縺ｧ蟋九∪繧�42譁�ｭ�)");
    }
    if (!etherscanKey) throw new Error("Etherscan API繧ｭ繝ｼ縺梧悴險ｭ螳壹〒縺�");
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
      throw new Error("繧｢繝峨Ξ繧ｹ縺ｮ蠖｢蠑上′豁｣縺励￥縺ｪ縺�ｈ縺�〒縺�");
    }
    if (!heliusKey) throw new Error("Helius API繧ｭ繝ｼ縺梧悴險ｭ螳壹〒縺�");
    const res = await fetch(
      `https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${heliusKey}`
    );
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("諠ｳ螳壼､悶�繝ｬ繧ｹ繝昴Φ繧ｹ蠖｢蠑上〒縺励◆");

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

  const fetchSui = async () => {
    const addr = addresses.sui.trim();
    if (!/^0x[a-fA-F0-9]{64}$/.test(addr)) {
      throw new Error("繧｢繝峨Ξ繧ｹ縺ｮ蠖｢蠑上′豁｣縺励￥縺ゅｊ縺ｾ縺帙ｓ(0x縺ｧ蟋九∪繧�66譁�ｭ�)");
    }
    const query = `
      query($addr: SuiAddress!) {
        address(address: $addr) {
          transactions(last: 50) {
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
    const res = await fetch(SUI_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { addr } }),
    });
    if (!res.ok) throw new Error(`API error ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0]?.message || "GraphQL繧ｨ繝ｩ繝ｼ");

    const txNodes = json.data?.address?.transactions?.nodes || [];
    const mapped = [];

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
        const decimals = 9; // 證ｫ螳�:SUI莉･螟悶�譯∵焚縺檎焚縺ｪ繧句庄閭ｽ諤ｧ縺ゅｊ(隕∬ｪｿ謨ｴ)
        const value = Number(amountRaw) / Math.pow(10, decimals);

        mapped.push({
          id: `sui-${digest}-${idx}`,
          chain: "sui",
          date: timestamp,
          type: isSwap ? "swap" : value > 0 ? "receive" : "send",
          asset: symbol,
          amount: value,
          counterparty: null,
          txHash: digest,
        });
      });
    });

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
      } else if (activeChain === "sol") {
        fresh = await fetchSolana();
      } else if (activeChain === "sui") {
        fresh = await fetchSui();
      }
      setTxs((prev) => {
        const existingIds = new Set(prev.map((t) => t.id));
        const newOnes = fresh.filter((t) => !existingIds.has(t.id));
        const next = [...newOnes, ...prev];
        persistTxs(next);
        setStatus(
          newOnes.length > 0
            ? `${newOnes.length}莉ｶ縺ｮ蜿門ｼ輔ｒ蜿門ｾ励＠縺ｾ縺励◆(蜷郁ｨ�${fresh.length}莉ｶ繧堤｢ｺ隱�)`
            : "譁ｰ縺励＞蜿門ｼ輔�縺ゅｊ縺ｾ縺帙ｓ縺ｧ縺励◆(縺吶〒縺ｫ蜿門ｾ玲ｸ医∩縺ｧ縺�)"
        );
        return next;
      });
    } catch (e) {
      console.error(e);
      setError(`蜿門ｾ励↓螟ｱ謨励＠縺ｾ縺励◆(${e.message || "unknown error"})縲ゅ％縺ｮ逕ｻ髱｢縺九ｉ逶ｴ謗･繧｢繧ｯ繧ｻ繧ｹ縺ｧ縺阪↑縺�庄閭ｽ諤ｧ縺後≠繧翫∪縺吶Ａ);
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
          <h1 style={styles.title}>繝槭Ν繝√メ繧ｧ繝ｼ繝ｳ蜿門ｼ輔ヨ繝ｩ繝�き繝ｼ</h1>
        </div>
        <button
          style={{ ...styles.iconBtn, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 8 }}
          onClick={() => setShowKeys((s) => !s)}
          title="API繧ｭ繝ｼ險ｭ螳�"
        >
          <Settings size={16} color={COLORS.textDim} />
        </button>
      </header>

      {showKeys && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>API繧ｭ繝ｼ險ｭ螳�</div>
          <div style={styles.note}>
            Ethereum繝ｻBNB Chain縺ｯ蜈ｱ騾壹�<strong>Etherscan API繧ｭ繝ｼ</strong>(V2 API縲∫┌譁呎棧縺ゅｊ)縲ヾolana縺ｯ
            <strong>Helius API繧ｭ繝ｼ</strong>(辟｡譁呎棧縺ゅｊ)繧剃ｽｿ縺�∪縺吶ゅ←縺｡繧峨ｂ繝悶Λ繧ｦ繧ｶ縺ｫ菫晏ｭ倥＆繧後ｋ縺�縺代〒縲√し繝ｼ繝舌�縺ｫ縺ｯ騾∽ｿ｡縺輔ｌ縺ｾ縺帙ｓ縲�
            Sui縺ｯ蜈ｬ蠑秀raphQL繧ｨ繝ｳ繝峨�繧､繝ｳ繝医ｒ逶ｴ謗･菴ｿ縺�◆繧√、PI繧ｭ繝ｼ縺ｯ荳崎ｦ√〒縺吶�
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Etherscan API繧ｭ繝ｼ(ETH/BNB蜈ｱ騾�)</label>
            <input
              style={styles.input}
              type="password"
              value={keyDraft.etherscan}
              onChange={(e) => setKeyDraft((s) => ({ ...s, etherscan: e.target.value }))}
              placeholder="逋ｺ陦後＠縺蘗PI繧ｭ繝ｼ繧定ｲｼ繧贋ｻ倥￠"
            />
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Helius API繧ｭ繝ｼ(Solana)</label>
            <input
              style={styles.input}
              type="password"
              value={keyDraft.helius}
              onChange={(e) => setKeyDraft((s) => ({ ...s, helius: e.target.value }))}
              placeholder="逋ｺ陦後＠縺蘗PI繧ｭ繝ｼ繧定ｲｼ繧贋ｻ倥￠"
            />
          </div>
          <button style={styles.btnPrimary} onClick={saveKeys}>
            菫晏ｭ�
          </button>
        </div>
      )}

      <div style={styles.card}>
        <div style={styles.cardTitle}>繧ｦ繧ｩ繝ｬ繝�ヨ縺九ｉ蜿門ｾ�</div>
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
            placeholder={
              activeChain === "sol"
                ? "Solana繧｢繝峨Ξ繧ｹ"
                : activeChain === "sui"
                ? "0x窶ｦ 縺ｧ蟋九∪繧九い繝峨Ξ繧ｹ(66譁�ｭ�)"
                : "0x窶ｦ 縺ｧ蟋九∪繧九い繝峨Ξ繧ｹ"
            }
          />
          <button style={{ ...styles.btnPrimary, opacity: fetching ? 0.6 : 1 }} disabled={fetching} onClick={handleFetch}>
            {fetching ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={16} />}
            {fetching ? "蜿門ｾ嶺ｸｭ窶ｦ" : "蜿門ｾ�"}
          </button>
        </div>
        {error && <div style={styles.errorBanner}>{error}</div>}
        {!fetching && status && <div style={styles.successBanner}>{status}</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.tableHeaderRow}>
          <div style={styles.cardTitle}>蜿門ｼ穂ｸ隕ｧ({filteredTxs.length}莉ｶ)</div>
          <div style={styles.modeToggle}>
            {["all", "eth", "bnb", "sol", "sui"].map((f) => (
              <button
                key={f}
                onClick={() => setChainFilter(f)}
                style={{ ...styles.modeBtn, ...(chainFilter === f ? styles.modeBtnActive : {}) }}
              >
                {f === "all" ? "縺吶∋縺ｦ" : CHAINS[f].label}
              </button>
            ))}
          </div>
        </div>

        {filteredTxs.length === 0 ? (
          <div style={styles.emptyState}>
            縺ｾ縺�蜿門ｼ輔′縺ゅｊ縺ｾ縺帙ｓ縲ゆｸ翫�縲悟叙蠕励阪°繧峨え繧ｩ繝ｬ繝�ヨ繧｢繝峨Ξ繧ｹ繧貞�蜉帙＠縺ｦ縺上□縺輔＞縲�
          </div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {["譌･譎�", "繝√ぉ繝ｼ繝ｳ", "遞ｮ蛻･", "驫俶氛", "謨ｰ驥�", "逶ｸ謇九い繝峨Ξ繧ｹ", ""].map((h) => (
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
                        {typeIcon(t.type)} {t.type === "send" ? "騾�≡" : t.type === "swap" ? "繧ｹ繝ｯ繝��" : "蜿嶺ｿ｡"}
                      </span>
                    </td>
                    <td style={{ ...styles.td, fontWeight: 600 }}>{t.asset}</td>
                    <td style={{ ...styles.td, color: t.amount >= 0 ? COLORS.profit : COLORS.loss, fontWeight: 700 }}>
                      {t.amount >= 0 ? "+" : ""}
                      {fmtAmt(t.amount)}
                    </td>
                    <td style={{ ...styles.td, fontFamily: "monospace", fontSize: 11 }}>
                      {t.counterparty ? `${t.counterparty.slice(0, 6)}...${t.counterparty.slice(-4)}` : "窶�"}
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
        迴ｾ谿ｵ髫弱�隧ｦ菴�(v1)縺ｧ縺�:騾�≡繝ｻ繝医�繧ｯ繝ｳ遘ｻ蜍輔�荳隕ｧ陦ｨ遉ｺ縺ｾ縺ｧ繧貞ｮ溯｣�＠縺ｦ縺�∪縺吶よ錐逶願ｨ育ｮ�(邱丞ｹｳ蝮�ｳ�)繝ｻDeFi繝ｻ繧ｹ繝ｯ繝��縺ｮ隧ｳ邏ｰ蛻､螳壹�谺｡縺ｮ谿ｵ髫弱〒霑ｽ蜉�莠亥ｮ壹〒縺吶�
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
  i

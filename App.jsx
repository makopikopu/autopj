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

const NATIVE_COINGECKO = { ETH: "ethereum", BNB: "binancecoin", SOL: "solana", SUI: "sui" };
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "DAI", "BUSD", "TUSD", "USDC.E"]);

function extractCoinSymbol(coinTypeRepr) {
  const parts = coinTypeRepr.split("::");
  return parts[parts.length - 1] || coinTypeRepr;
}

const STORAGE_TX_KEY = "wallet-ledger:transactions";
const STORAGE_KEYS_KEY = "wallet-ledger:api-keys";
const STORAGE_ADDR_KEY = "wallet-ledger:addresses";
const STORAGE_CONTRACT_PRICE_KEY = "wallet-ledger:contract-prices"; // コントラクトアドレス⇔銘柄の登録一覧
const STORAGE_HIST_PRICE_KEY = "wallet-ledger:hist-prices"; // 日付ごとの時価キャッシュ(chain|symbol|date -> USD価格)
const STORAGE_CURRENT_PRICE_KEY = "wallet-ledger:current-prices"; // 現在の時価キャッシュ(chain|symbol -> USD価格)
const STORAGE_HIDDEN_ASSETS_KEY = "wallet-ledger:hidden-assets"; // 非表示にした保有銘柄(chain|wallet|asset の一覧)
const STORAGE_ONCHAIN_BAL_KEY = "wallet-ledger:onchain-balances"; // チェーンから直接取得した残高(chain|wallet|asset -> 数量)

function fmtAmt(n, digits = 6) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("ja-JP", { maximumFractionDigits: digits });
}

function fmtDate(iso) {
  if (!iso) return "—";
  return iso.slice(0, 16).replace("T", " ");
}

// 追加ライブラリ無しのシンプルなSVG円グラフ
function PieChart({ data, colors, size = 200 }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total <= 0) return null;
  const radius = size / 2;
  const cx = radius;
  const cy = radius;
  let cumulative = 0;

  const polarToCartesian = (angleDeg) => {
    const angleRad = ((angleDeg - 90) * Math.PI) / 180;
    return { x: cx + radius * Math.cos(angleRad), y: cy + radius * Math.sin(angleRad) };
  };

  const slices = data.map((d, i) => {
    const startAngle = (cumulative / total) * 360;
    cumulative += d.value;
    const endAngle = (cumulative / total) * 360;
    const largeArc = endAngle - startAngle > 180 ? 1 : 0;
    const start = polarToCartesian(startAngle);
    const end = polarToCartesian(endAngle);
    // 円グラフが1スライスだけ(100%)の場合はpath方式だと描けないので円として描く
    if (data.length === 1) {
      return <circle key={d.asset} cx={cx} cy={cy} r={radius} fill={colors[i % colors.length]} />;
    }
    const path = `M ${cx} ${cy} L ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y} Z`;
    return <path key={d.asset} d={path} fill={colors[i % colors.length]} stroke="#0F1218" strokeWidth={1} />;
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {slices}
    </svg>
  );
}

export default function App() {
  const [txs, setTxs] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const [etherscanKey, setEtherscanKey] = useState("");
  const [heliusKey, setHeliusKey] = useState("");
  const [meganodeKey, setMeganodeKey] = useState(""); // BNB Chain用(BSCTrace/MegaNode、無料枠)
  const [birdeyeKey, setBirdeyeKey] = useState(""); // 時価取得用(Birdeye、無料枠)
  const [showKeys, setShowKeys] = useState(false);
  const [keyDraft, setKeyDraft] = useState({ etherscan: "", helius: "", meganode: "", birdeye: "" });

  const [contractPrices, setContractPrices] = useState({ eth: [], bnb: [], sol: [], sui: [] });
  const [activePriceChain, setActivePriceChain] = useState("eth");
  const [priceFetching, setPriceFetching] = useState(false);
  const [priceStatus, setPriceStatus] = useState("");
  const [priceError, setPriceError] = useState("");
  const [histPrices, setHistPrices] = useState({}); // key: `${chain}|${symbol}|${isoDate}` -> USD価格
  const [currentPrices, setCurrentPrices] = useState({}); // key: `${chain}|${symbol}` -> 現在のUSD価格
  const [hiddenAssets, setHiddenAssets] = useState({}); // key: `${chain}|${wallet}|${asset}` -> true
  const [onchainBalances, setOnchainBalances] = useState({}); // key: `${chain}|${wallet}|${asset}` -> 数量(チェーンから直接取得)
  const [showHiddenAssets, setShowHiddenAssets] = useState(false);
  const [holdingsFetching, setHoldingsFetching] = useState(false);
  const [holdingsStatus, setHoldingsStatus] = useState("");

  const [addresses, setAddresses] = useState({ eth: [], bnb: [], sol: [], sui: [] });
  const [activeChain, setActiveChain] = useState("eth");
  const [chainFilter, setChainFilter] = useState("all");
  const [walletFilter, setWalletFilter] = useState("all");

  const [fetching, setFetching] = useState(false);
  const coinDecimalsCacheRef = useRef({}); // Suiのコイン種類ごとのdecimalsをキャッシュ(セッション内のみ)
  const solTokenSymbolCacheRef = useRef({}); // Solanaのmintアドレスごとのシンボルをキャッシュ(セッション内のみ)
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
          setMeganodeKey(parsed.meganode || "");
          setBirdeyeKey(parsed.birdeye || "");
          setKeyDraft({
            etherscan: parsed.etherscan || "",
            helius: parsed.helius || "",
            meganode: parsed.meganode || "",
            birdeye: parsed.birdeye || "",
          });
        }
      } catch (e) {}
      try {
        const cp = await storage.get(STORAGE_CONTRACT_PRICE_KEY, false);
        if (cp && cp.value) {
          const parsed = JSON.parse(cp.value);
          setContractPrices((prev) => ({ ...prev, ...parsed }));
        }
      } catch (e) {}
      try {
        const hp = await storage.get(STORAGE_HIST_PRICE_KEY, false);
        if (hp && hp.value) {
          const parsed = JSON.parse(hp.value);
          setHistPrices(parsed || {});
        }
      } catch (e) {}
      try {
        const cur = await storage.get(STORAGE_CURRENT_PRICE_KEY, false);
        if (cur && cur.value) {
          const parsed = JSON.parse(cur.value);
          setCurrentPrices(parsed || {});
        }
      } catch (e) {}
      try {
        const hid = await storage.get(STORAGE_HIDDEN_ASSETS_KEY, false);
        if (hid && hid.value) {
          const parsed = JSON.parse(hid.value);
          setHiddenAssets(parsed || {});
        }
      } catch (e) {}
      try {
        const ob = await storage.get(STORAGE_ONCHAIN_BAL_KEY, false);
        if (ob && ob.value) {
          const parsed = JSON.parse(ob.value);
          setOnchainBalances(parsed || {});
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
    setMeganodeKey(keyDraft.meganode.trim());
    setBirdeyeKey(keyDraft.birdeye.trim());
    setShowKeys(false);
    try {
      await storage.set(
        STORAGE_KEYS_KEY,
        JSON.stringify({
          etherscan: keyDraft.etherscan.trim(),
          helius: keyDraft.helius.trim(),
          meganode: keyDraft.meganode.trim(),
          birdeye: keyDraft.birdeye.trim(),
        }),
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

  const clearChainData = (chainKey) => {
    const ok = window.confirm(`${CHAINS[chainKey].label}の取引データを全て削除します。よろしいですか?`);
    if (!ok) return;
    setTxs((prev) => {
      const next = prev.filter((t) => t.chain !== chainKey);
      persistTxs(next);
      return next;
    });
    setStatus(`${CHAINS[chainKey].label}の取引データを削除しました。「取得」で再取得してください。`);
  };

  // 保存済みのSolana取引の銘柄名を再解決する
  // (Heliusは直近分しか返さないため、古い取引の銘柄名は再取得では直らない。
  //  取引IDに埋め込まれたmintアドレスから逆引きして、保存データを直接直す)
  const fixSolanaSymbols = async () => {
    // id形式: sol-{signature}-{mint}-{from}-{to} / sol-{signature}-native-...
    const mintOfTx = (t) => {
      if (t.chain !== "sol") return null;
      const parts = (t.id || "").split("-");
      if (parts.length < 3) return null;
      const mint = parts[2];
      if (!mint || mint === "native" || mint.length < 32) return null;
      return mint;
    };

    // 「未解決っぽい」判定: 銘柄名がmintアドレスの先頭4文字と一致している
    const targets = txs.filter((t) => {
      const mint = mintOfTx(t);
      return mint && t.asset === mint.slice(0, 4);
    });
    if (targets.length === 0) {
      setStatus("銘柄名が未解決のSolana取引は見つかりませんでした");
      return;
    }

    setFetching(true);
    setError("");
    setStatus("銘柄名を解決中…");
    try {
      const mints = Array.from(new Set(targets.map((t) => mintOfTx(t))));
      // 以前「見つからなかった」と記録された分も、再度問い合わせられるようにリセット
      mints.forEach((m) => {
        if (solTokenSymbolCache[m] === null) delete solTokenSymbolCache[m];
      });
      await fetchSolanaTokenSymbols(mints);
      let fixedCount = 0;
      setTxs((prev) => {
        const next = prev.map((t) => {
          const mint = mintOfTx(t);
          if (!mint || t.asset !== mint.slice(0, 4)) return t;
          const resolved = solTokenSymbolCache[mint];
          if (resolved) {
            fixedCount += 1;
            return { ...t, asset: resolved };
          }
          return t;
        });
        persistTxs(next);
        return next;
      });
      setStatus(
        `${mints.length}種類のトークンを照会し、${fixedCount}件の取引の銘柄名を修正しました` +
          (fixedCount === 0 ? "(どのAPIにも情報が無いトークンでした)" : "")
      );
    } finally {
      setFetching(false);
    }
  };

  // ---------- コントラクトアドレス⇔銘柄の登録(時価反映用) ----------
  const persistContractPrices = async (next) => {
    try {
      await storage.set(STORAGE_CONTRACT_PRICE_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  const persistHistPrices = async (next) => {
    try {
      await storage.set(STORAGE_HIST_PRICE_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  const addContractPriceRow = (chain) => {
    const next = { ...contractPrices, [chain]: [...(contractPrices[chain] || []), { symbol: "", address: "" }] };
    setContractPrices(next);
    persistContractPrices(next);
  };

  const updateContractPriceRow = (chain, index, field, value) => {
    const next = { ...contractPrices };
    next[chain] = next[chain].map((row, i) => (i === index ? { ...row, [field]: value } : row));
    setContractPrices(next);
    persistContractPrices(next);
  };

  const removeContractPriceRow = (chain, index) => {
    const next = { ...contractPrices };
    next[chain] = next[chain].filter((_, i) => i !== index);
    setContractPrices(next);
    persistContractPrices(next);
  };

  // Birdeyeのx-chainヘッダーへの変換
  const BIRDEYE_CHAIN_MAP = { eth: "ethereum", bnb: "bsc", sol: "solana", sui: "sui" };

  // 指定した日(UTC 0時〜24時)の代表的な価格を1つ取得。データが無い日は前後に範囲を広げて再検索する
  const fetchBirdeyeDayPrice = async (chain, address, isoDate) => {
    const xchain = BIRDEYE_CHAIN_MAP[chain];
    const dayStart = Math.floor(new Date(`${isoDate}T00:00:00Z`).getTime() / 1000);

    const query = async (timeFrom, timeTo) => {
      const url = `https://public-api.birdeye.so/defi/history_price?address=${address}&address_type=token&type=1D&time_from=${timeFrom}&time_to=${timeTo}`;
      const res = await fetch(url, {
        headers: { "X-API-KEY": birdeyeKey, "x-chain": xchain, accept: "application/json" },
      });
      if (!res.ok) throw new Error(`Birdeye API error ${res.status}`);
      const json = await res.json();
      if (json.success === false) throw new Error(json.message || "Birdeyeエラー");
      return json?.data?.items || [];
    };

    // まず対象日ぴったりを検索
    let items = await query(dayStart, dayStart + 86400);
    if (items.length > 0) {
      return typeof items[0].value === "number" ? items[0].value : null;
    }

    // データが無ければ前後3日に範囲を広げ、対象日に最も近いものを採用
    await new Promise((resolve) => setTimeout(resolve, 1100));
    items = await query(dayStart - 3 * 86400, dayStart + 4 * 86400);
    if (items.length === 0) return null;
    let closest = items[0];
    let closestDiff = Math.abs((closest.unixTime ?? dayStart) - dayStart);
    for (const item of items) {
      const diff = Math.abs((item.unixTime ?? dayStart) - dayStart);
      if (diff < closestDiff) {
        closest = item;
        closestDiff = diff;
      }
    }
    return typeof closest.value === "number" ? closest.value : null;
  };

  // 登録したコントラクトアドレス1件ぶん、取引履歴にある日付すべての時価を取得してhistPricesに反映
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const applyContractPrice = async (chain, symbol, address) => {
    if (!birdeyeKey) {
      setPriceError("Birdeye APIキーが未設定です");
      return;
    }
    const cleanAddress = address.trim();
    const cleanSymbol = symbol.trim();
    if (!cleanAddress || !cleanSymbol) {
      setPriceError("銘柄名とコントラクトアドレスの両方を入力してください");
      return;
    }
    const dates = Array.from(
      new Set(
        txs
          .filter((t) => t.chain === chain && t.asset === cleanSymbol && t.date)
          .map((t) => t.date.slice(0, 10))
      )
    );
    if (dates.length === 0) {
      setPriceError(`${cleanSymbol}の取引が取引一覧の中に見つかりませんでした(銘柄名の表記が一致しているか確認してください)`);
      return;
    }

    setPriceFetching(true);
    setPriceError("");
    setPriceStatus("");
    let filled = 0;
    let failed = 0;
    try {
      let current = { ...histPrices };
      const pending = dates.filter((d) => current[`${chain}|${cleanSymbol}|${d}`] === undefined);
      for (let i = 0; i < pending.length; i++) {
        const isoDate = pending[i];
        const key = `${chain}|${cleanSymbol}|${isoDate}`;
        setPriceStatus(`${cleanSymbol}の時価を取得中… (${i + 1}/${pending.length})`);
        let price = null;
        let ok = false;
        // Birdeyeは全キー合計で60rpm(1秒強に1回)までのため、1リクエストごとに間隔を空ける
        for (let attempt = 0; attempt < 2 && !ok; attempt++) {
          try {
            if (attempt > 0) await sleep(2000); // リトライ前は少し長めに待つ
            price = await fetchBirdeyeDayPrice(chain, cleanAddress, isoDate);
            ok = true;
          } catch (e) {
            // 1回だけリトライ、それでも失敗したら諦める
          }
        }
        if (ok) {
          current = { ...current, [key]: price };
          if (price !== null) filled += 1;
          else failed += 1; // データ自体が存在しなかった(nullで返ってきた)
        } else {
          failed += 1;
        }
        if (i < pending.length - 1) await sleep(1100); // 60rpm制限を守るための間隔
      }
      setHistPrices(current);
      persistHistPrices(current);
      setPriceStatus(
        `${cleanSymbol}: ${dates.length}日ぶん中 ${filled}件の時価を反映しました${failed > 0 ? `(${failed}件は取得失敗・データ無し)` : ""}`
      );
    } finally {
      setPriceFetching(false);
    }
  };

  // 取引一覧で使う: その取引の当時の時価(USD)を引く。無ければnull。
  const histPriceFor = (chain, symbol, isoDate) => {
    if (!isoDate) return null;
    const v = histPrices[`${chain}|${symbol}|${isoDate}`];
    return typeof v === "number" ? v : null;
  };

  // ---------- 保有残高・現在時価 ----------

  const persistCurrentPrices = async (next) => {
    try {
      await storage.set(STORAGE_CURRENT_PRICE_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  const persistHiddenAssets = async (next) => {
    try {
      await storage.set(STORAGE_HIDDEN_ASSETS_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  const hideAsset = (chain, wallet, asset) => {
    const key = `${chain}|${wallet}|${asset}`;
    const next = { ...hiddenAssets, [key]: true };
    setHiddenAssets(next);
    persistHiddenAssets(next);
  };

  const unhideAsset = (chain, wallet, asset) => {
    const key = `${chain}|${wallet}|${asset}`;
    const next = { ...hiddenAssets };
    delete next[key];
    setHiddenAssets(next);
    persistHiddenAssets(next);
  };

  const fetchBirdeyeCurrentPrice = async (chain, address) => {
    const xchain = BIRDEYE_CHAIN_MAP[chain];
    const url = `https://public-api.birdeye.so/defi/price?address=${address}`;
    const res = await fetch(url, {
      headers: { "X-API-KEY": birdeyeKey, "x-chain": xchain, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Birdeye API error ${res.status}`);
    const json = await res.json();
    if (json.success === false) throw new Error(json.message || "Birdeyeエラー");
    const v = json?.data?.value;
    return typeof v === "number" ? v : null;
  };

  const fetchNativeCurrentPrices = async () => {
    try {
      const ids = Object.values(NATIVE_COINGECKO).join(",");
      const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd`);
      const data = await res.json();
      const next = { ...currentPrices };
      for (const chain of Object.keys(CHAINS)) {
        const symbol = CHAINS[chain].native;
        const geckoId = NATIVE_COINGECKO[symbol];
        const p = data?.[geckoId]?.usd;
        if (typeof p === "number") next[`${chain}|${symbol}`] = p;
      }
      setCurrentPrices(next);
      persistCurrentPrices(next);
    } catch (e) {
      console.error("native price fetch failed", e);
    }
  };

  const fetchAllCurrentPrices = async () => {
    setHoldingsFetching(true);
    setHoldingsStatus("");
    try {
      await fetchNativeCurrentPrices();
      if (birdeyeKey) {
        let next = { ...currentPrices };
        const rows = [];
        for (const chain of Object.keys(contractPrices)) {
          for (const row of contractPrices[chain] || []) {
            if (row.symbol.trim() && row.address.trim()) rows.push({ chain, ...row });
          }
        }
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          setHoldingsStatus(`時価を取得中… (${i + 1}/${rows.length})`);
          try {
            const price = await fetchBirdeyeCurrentPrice(row.chain, row.address.trim());
            next = { ...next, [`${row.chain}|${row.symbol.trim()}`]: price };
          } catch (e) {
            // 1件失敗しても続行
          }
          if (i < rows.length - 1) await sleep(1100);
        }
        setCurrentPrices(next);
        persistCurrentPrices(next);
      }
      setHoldingsStatus("現在の時価を更新しました");
    } finally {
      setHoldingsFetching(false);
    }
  };

  // ---------- Solana/Suiのチェーンから現在残高を直接取得 ----------
  // Heliusの取引履歴APIは直近約100件しか返さないため、履歴の合計から残高を逆算すると
  // 古い取引が抜けて数字が合わない。Solana/Suiは残高を直接取得する。
  // (Ethereum/BNBは全履歴が取れるため、履歴からの逆算のままで正確)

  const persistOnchainBalances = async (next) => {
    try {
      await storage.set(STORAGE_ONCHAIN_BAL_KEY, JSON.stringify(next), false);
    } catch (e) {
      console.error(e);
    }
  };

  const SOL_TOKEN_PROGRAMS = [
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // 通常のSPLトークン
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // Token-2022
  ];

  const fetchOnchainBalances = async () => {
    setHoldingsFetching(true);
    setHoldingsStatus("残高をチェーンから取得中…");
    try {
      const next = { ...onchainBalances };

      // ---- Solana ----
      if (heliusKey) {
        const solRpc = async (method, params) => {
          const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          });
          if (!res.ok) throw new Error(`Solana RPC error ${res.status}`);
          const json = await res.json();
          if (json.error) throw new Error(json.error.message || "Solana RPCエラー");
          return json.result;
        };

        for (const row of addresses.sol || []) {
          const addr = row.address.trim();
          if (!addr) continue;
          // このウォレットの古い残高エントリを一旦クリア
          Object.keys(next).forEach((k) => {
            if (k.startsWith(`sol|${addr}|`)) delete next[k];
          });
          try {
            const balResult = await solRpc("getBalance", [addr]);
            const sol = (balResult?.value || 0) / 1e9;
            if (sol > 0) next[`sol|${addr}|SOL`] = sol;

            const qtyByMint = {};
            for (const programId of SOL_TOKEN_PROGRAMS) {
              try {
                const tokRes = await solRpc("getTokenAccountsByOwner", [
                  addr,
                  { programId },
                  { encoding: "jsonParsed" },
                ]);
                for (const acc of tokRes?.value || []) {
                  const info = acc?.account?.data?.parsed?.info;
                  const mint = info?.mint;
                  const uiAmount = info?.tokenAmount?.uiAmount;
                  if (mint && typeof uiAmount === "number" && uiAmount > 0) {
                    qtyByMint[mint] = (qtyByMint[mint] || 0) + uiAmount;
                  }
                }
              } catch (e) {
                console.error(`token accounts fetch failed (${programId})`, e);
              }
            }
            const mints = Object.keys(qtyByMint);
            if (mints.length > 0) {
              await fetchSolanaTokenSymbols(mints);
              const usedSymbols = new Set();
              for (const mint of mints) {
                let symbol = solTokenSymbolCache[mint] || mint.slice(0, 4);
                // 同じ銘柄名を名乗る別トークン(偽物の可能性あり)は合算せず、mintの一部を付けて区別する
                if (usedSymbols.has(symbol)) {
                  symbol = `${symbol}(${mint.slice(0, 4)})`;
                }
                usedSymbols.add(symbol);
                next[`sol|${addr}|${symbol}`] = qtyByMint[mint];
              }
            }
          } catch (e) {
            console.error("solana balance fetch failed", e);
          }
        }
      }

      // ---- Sui ----
      for (const row of addresses.sui || []) {
        const addr = row.address.trim();
        if (!addr) continue;
        const addrKey = addr.toLowerCase();
        Object.keys(next).forEach((k) => {
          if (k.startsWith(`sui|${addrKey}|`)) delete next[k];
        });
        try {
          const query = `
            query($addr: SuiAddress!) {
              address(address: $addr) {
                balances {
                  nodes {
                    coinType { repr }
                    totalBalance
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
          if (!res.ok) throw new Error(`Sui API error ${res.status}`);
          const json = await res.json();
          if (json.errors) throw new Error(json.errors[0]?.message || "Sui GraphQLエラー");
          const nodes = json?.data?.address?.balances?.nodes || [];
          for (const node of nodes) {
            const repr = node?.coinType?.repr;
            const raw = node?.totalBalance;
            if (!repr || raw === undefined) continue;
            const decimals = await fetchCoinDecimals(repr);
            const qty = Number(BigInt(raw)) / Math.pow(10, decimals);
            if (qty <= 0) continue;
            const symbol = extractCoinSymbol(repr);
            next[`sui|${addrKey}|${symbol}`] = (next[`sui|${addrKey}|${symbol}`] || 0) + qty;
          }
        } catch (e) {
          console.error("sui balance fetch failed", e);
        }
      }

      setOnchainBalances(next);
      persistOnchainBalances(next);
      setHoldingsStatus("チェーンから残高を取得しました(Solana/Sui)。Ethereum/BNBは取引履歴からの計算です。");
    } finally {
      setHoldingsFetching(false);
    }
  };

  const holdingsRows = useMemo(() => {
    // チェーンから直接取得済みのウォレット(chain|wallet)一覧
    const onchainWallets = new Set(
      Object.keys(onchainBalances).map((k) => {
        const [chain, wallet] = k.split("|");
        return `${chain}|${wallet.toLowerCase()}`;
      })
    );

    // 取引履歴からの逆算(直接取得済みのウォレットは除外)
    const map = {};
    for (const t of txs) {
      if (!t.wallet) continue;
      if (onchainWallets.has(`${t.chain}|${t.wallet.toLowerCase()}`)) continue;
      const key = `${t.chain}|${t.wallet}|${t.asset}`;
      map[key] = (map[key] || 0) + t.amount;
    }
    // 直接取得した残高を合流
    for (const [key, qty] of Object.entries(onchainBalances)) {
      map[key] = qty;
    }

    return Object.entries(map)
      .filter(([, qty]) => Math.abs(qty) > 1e-9)
      .map(([key, qty]) => {
        const [chain, wallet, asset] = key.split("|");
        const price = currentPrices[`${chain}|${asset}`];
        const valueUsd = typeof price === "number" ? price * qty : null;
        return { key, chain, wallet, asset, qty, price: typeof price === "number" ? price : null, valueUsd };
      })
      .filter((r) => showHiddenAssets || !hiddenAssets[r.key]);
  }, [txs, currentPrices, hiddenAssets, showHiddenAssets, onchainBalances]);

  const pieData = useMemo(() => {
    const priced = holdingsRows.filter((r) => !hiddenAssets[r.key] && r.valueUsd !== null && r.valueUsd > 0);
    const total = priced.reduce((s, r) => s + r.valueUsd, 0);
    if (total <= 0) return { total: 0, slices: [] };
    const byAsset = {};
    for (const r of priced) {
      byAsset[r.asset] = (byAsset[r.asset] || 0) + r.valueUsd;
    }
    const entries = Object.entries(byAsset).map(([asset, value]) => ({
      asset,
      value,
      pct: (value / total) * 100,
    }));
    entries.sort((a, b) => b.value - a.value);
    const major = entries.filter((e) => e.pct >= 1);
    const minor = entries.filter((e) => e.pct < 1);
    const slices = [...major];
    if (minor.length > 0) {
      const otherValue = minor.reduce((s, e) => s + e.value, 0);
      slices.push({ asset: "その他", value: otherValue, pct: (otherValue / total) * 100 });
    }
    return { total, slices };
  }, [holdingsRows, hiddenAssets]);

  const PIE_COLORS = [
    "#D9A441", "#3ECF8E", "#F0576B", "#627EEA", "#14F195",
    "#F0B90B", "#4DA2FF", "#A78BFA", "#F472B6", "#38BDF8",
    "#FB923C", "#94A3B8",
  ];

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

    // status "0" でも「取引が0件」は正常。それ以外のエラーメッセージは表面化する
    const isRealError = (d) =>
      d.status === "0" && d.message && !/no transactions found/i.test(d.message) && !/no records/i.test(d.message);
    if (isRealError(nativeData)) {
      throw new Error(`Etherscan API: ${nativeData.message}${nativeData.result ? ` (${nativeData.result})` : ""}`);
    }
    if (isRealError(tokenData)) {
      throw new Error(`Etherscan API: ${tokenData.message}${tokenData.result ? ` (${tokenData.result})` : ""}`);
    }

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

  // ---- BNB Chain専用: BSCTrace(MegaNode)経由での取得 ----
  // EtherscanはBNB Chainを無料プランから除外したため、無料枠のあるMegaNodeを使う。
  // MegaNodeはJSON-RPC形式で、1回のクエリで扱えるブロック範囲が最大10万ブロックまでのため、
  // その範囲ごとに区切って何度も問い合わせる必要がある。
  const MEGANODE_BASE = "https://bsc-mainnet.nodereal.io/v1";
  const MEGANODE_BLOCK_RANGE = 0x186a0; // 100,000 blocks

  const meganodeRpc = async (method, params) => {
    const res = await fetch(`${MEGANODE_BASE}/${meganodeKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    if (!res.ok) throw new Error(`MegaNode API error ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`MegaNode: ${json.error.message || "unknown error"}`);
    return json.result;
  };

  // fromAddress または toAddress で絞り込みつつ、ブロック範囲・pageKeyでページングして全件集める
  const fetchAssetTransfersAll = async (addr, direction, latestBlockHex) => {
    const latestBlock = parseInt(latestBlockHex, 16);
    const results = [];
    let fromBlock = 0;
    while (fromBlock <= latestBlock) {
      const toBlock = Math.min(fromBlock + MEGANODE_BLOCK_RANGE, latestBlock);
      let pageKey = undefined;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const params = {
          category: ["external", "20"],
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          order: "asc",
          maxCount: "0x3E8",
        };
        if (direction === "from") params.fromAddress = addr;
        else params.toAddress = addr;
        if (pageKey) params.pageKey = pageKey;

        const result = await meganodeRpc("nr_getAssetTransfers", [params]);
        const transfers = result?.transfers || [];
        results.push(...transfers);
        pageKey = result?.pageKey;
        if (!pageKey) break;
      }
      fromBlock = toBlock + 1;
    }
    return results;
  };

  const fetchBnbMegaNode = async (addr) => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
      throw new Error("アドレスの形式が正しくありません(0xで始まる42文字)");
    }
    if (!meganodeKey) throw new Error("MegaNode APIキーが未設定です(BNB Chainの取得にはMegaNodeのキーが必要です)");

    const latestBlockHex = await meganodeRpc("eth_blockNumber", []);

    const [fromTransfers, toTransfers] = await Promise.all([
      fetchAssetTransfersAll(addr, "from", latestBlockHex),
      fetchAssetTransfersAll(addr, "to", latestBlockHex),
    ]);

    // 同じtxが送受両方から重複して来ることがあるのでhashで重複排除
    const seen = new Map();
    for (const t of [...fromTransfers, ...toTransfers]) {
      const key = `${t.hash}-${t.category}-${t.contractAddress || "native"}-${t.value}`;
      seen.set(key, t);
    }

    const mapped = [];
    for (const t of seen.values()) {
      const isSend = t.from?.toLowerCase() === addr.toLowerCase();
      const decimals = t.category === "external" ? 18 : Number(t.decimal ? parseInt(t.decimal, 16) : 18) || 18;
      const value = Number(BigInt(t.value || "0x0")) / Math.pow(10, decimals);
      if (value === 0) continue;
      mapped.push({
        id: `bnb-${t.hash}-${t.contractAddress || "native"}-${t.from}-${t.to}`,
        chain: "bnb",
        wallet: addr.toLowerCase(),
        date: t.blockTimeStamp ? new Date(t.blockTimeStamp * 1000).toISOString() : null,
        type: isSend ? "send" : "receive",
        asset: t.asset || (t.category === "external" ? "BNB" : "?"),
        amount: isSend ? -value : value,
        counterparty: isSend ? t.to : t.from,
        txHash: t.hash,
      });
    }
    return mapped;
  };

  const solTokenSymbolCache = solTokenSymbolCacheRef.current;

  // よく知られたmintは固定でマッピング(APIに聞くまでもないもの)
  const KNOWN_SOL_MINTS = {
    So11111111111111111111111111111111111111112: "SOL", // Wrapped SOL
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  };

  const fetchSolanaTokenSymbols = async (mints) => {
    // 固定マッピングを先に反映
    mints.forEach((m) => {
      if (KNOWN_SOL_MINTS[m] && solTokenSymbolCache[m] === undefined) {
        solTokenSymbolCache[m] = KNOWN_SOL_MINTS[m];
      }
    });

    const uncached = mints.filter((m) => solTokenSymbolCache[m] === undefined);
    if (uncached.length > 0) {
      // 1段目: HeliusのDAS API getAssetBatch(現行の正式な取得方法。まとめて最大1000件)
      try {
        const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "token-symbols",
            method: "getAssetBatch",
            params: { ids: uncached },
          }),
        });
        if (res.ok) {
          const json = await res.json();
          const list = json?.result;
          if (Array.isArray(list)) {
            list.forEach((item) => {
              if (!item) return;
              const mint = item.id;
              const symbol = item.content?.metadata?.symbol || item.token_info?.symbol;
              if (mint && symbol && symbol.trim()) solTokenSymbolCache[mint] = symbol.trim();
            });
          }
        }
      } catch (e) {
        // 2段目に任せる
      }

      // 2段目: Heliusで解決できなかった分をJupiterトークンAPI V2(キー不要・無料)で1件ずつ解決
      const stillMissing = uncached.filter((m) => solTokenSymbolCache[m] === undefined);
      for (const mint of stillMissing) {
        try {
          const res = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${mint}`);
          if (res.ok) {
            const data = await res.json();
            // V2 searchは配列を返す。mintが一致するものを探す(先頭が一致することが多い)
            const hit = Array.isArray(data)
              ? data.find((d) => (d.id || d.address || d.mint) === mint) || data[0]
              : null;
            const symbol = hit?.symbol;
            if (symbol && symbol.trim()) {
              solTokenSymbolCache[mint] = symbol.trim();
              continue;
            }
          }
        } catch (e) {
          // 個別失敗は無視
        }
        solTokenSymbolCache[mint] = null; // どちらでも見つからなかった
      }
    }
    return solTokenSymbolCache;
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

    // ---- 先にtokenSymbolが無いトークンのmintアドレスを集める ----
    const missingMints = new Set();
    for (const t of data) {
      for (const tt of t.tokenTransfers || []) {
        if (!tt.tokenSymbol && tt.mint) missingMints.add(tt.mint);
      }
    }
    if (missingMints.size > 0) {
      await fetchSolanaTokenSymbols(Array.from(missingMints));
    }

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
        const resolvedSymbol = tt.tokenSymbol || solTokenSymbolCache[tt.mint];
        mapped.push({
          id: `sol-${t.signature}-${tt.mint}-${tt.fromUserAccount}-${tt.toUserAccount}`,
          chain: "sol",
          wallet: addr,
          date,
          type: isSend ? "send" : "receive",
          asset: resolvedSymbol || tt.mint?.slice(0, 4) || "?",
          amount: isSend ? -(tt.tokenAmount || 0) : tt.tokenAmount || 0,
          counterparty: isSend ? tt.toUserAccount : tt.fromUserAccount,
          txHash: t.signature,
        });
      }
    }
    return mapped;
  };

  const coinDecimalsCache = coinDecimalsCacheRef.current;

  const fetchCoinDecimals = async (coinTypeRepr) => {
    if (coinDecimalsCache[coinTypeRepr] !== undefined) return coinDecimalsCache[coinTypeRepr];
    try {
      const metaQuery = `
        query($type: String!) {
          coinMetadata(coinType: $type) {
            decimals
          }
        }
      `;
      const res = await fetch(SUI_GRAPHQL_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: metaQuery, variables: { type: coinTypeRepr } }),
      });
      const json = await res.json();
      const decimals = json?.data?.coinMetadata?.decimals;
      const result = typeof decimals === "number" ? decimals : 9; // 取得できなければ9をフォールバック
      coinDecimalsCache[coinTypeRepr] = result;
      return result;
    } catch (e) {
      return 9;
    }
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

    // ---- 1段階目: 生のトランザクションデータを全ページ取得 ----
    const rawEntries = []; // { digest, timestamp, isSwap, coinTypeRepr, amountRaw }
    const coinTypesSeen = new Set();
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
          const coinTypeRepr = change.coinType.repr;
          coinTypesSeen.add(coinTypeRepr);
          rawEntries.push({
            digest,
            idx,
            timestamp,
            isSwap,
            coinTypeRepr,
            amountRaw: BigInt(change.amount),
          });
        });
      });

      hasMore = !!txConn?.pageInfo?.hasPreviousPage;
      cursor = txConn?.pageInfo?.startCursor || null;
      page += 1;
      if (!cursor) hasMore = false;
    }

    // ---- 2段階目: 出てきたコイン種類ぶんだけdecimalsを取得(キャッシュ済みは再取得しない) ----
    const uniqueTypes = Array.from(coinTypesSeen);
    const decimalsList = await Promise.all(uniqueTypes.map((t) => fetchCoinDecimals(t)));
    const decimalsByType = {};
    uniqueTypes.forEach((t, i) => {
      decimalsByType[t] = decimalsList[i];
    });

    // ---- 3段階目: 正しいdecimalsで金額を換算して共通フォーマットに変換 ----
    const mapped = rawEntries.map((e) => {
      const decimals = decimalsByType[e.coinTypeRepr] ?? 9;
      const value = Number(e.amountRaw) / Math.pow(10, decimals);
      const symbol = extractCoinSymbol(e.coinTypeRepr);
      return {
        id: `sui-${e.digest}-${e.idx}`,
        chain: "sui",
        wallet: addr.toLowerCase(),
        date: e.timestamp,
        type: e.isSwap ? "swap" : value > 0 ? "receive" : "send",
        asset: symbol,
        amount: value,
        counterparty: null,
        txHash: e.digest,
      };
    });

    return mapped;
  };

  const fetchForAddress = async (chainKey, addr) => {
    if (chainKey === "eth") return fetchEvm(chainKey, addr);
    if (chainKey === "bnb") return fetchBnbMegaNode(addr);
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
      let result = { newOnesCount: 0, updatedCount: 0, total: 0 };
      setTxs((prev) => {
        // 同じIDの取引は最新データで上書きし、新規は追加する(銘柄名の解決などが後から反映されるように)
        const freshById = new Map(fresh.map((t) => [t.id, t]));
        const kept = prev.map((t) => (freshById.has(t.id) ? freshById.get(t.id) : t));
        const existingIds = new Set(prev.map((t) => t.id));
        const newOnes = fresh.filter((t) => !existingIds.has(t.id));
        const next = [...newOnes, ...kept];
        persistTxs(next);
        result = {
          newOnesCount: newOnes.length,
          updatedCount: fresh.length - newOnes.length,
          total: fresh.length,
        };
        return next;
      });
      setStatus(
        result.newOnesCount > 0
          ? `${result.newOnesCount}件の新しい取引を取得しました(既存${result.updatedCount}件も最新データで更新)`
          : `新しい取引はありませんでした(既存${result.updatedCount}件を最新データで更新しました)`
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
    let totalUpdated = 0;
    const failedLabels = [];
    try {
      for (const row of rows) {
        try {
          const fresh = await fetchForAddress(activeChain, row.address.trim());
          setTxs((prev) => {
            const freshById = new Map(fresh.map((t) => [t.id, t]));
            const kept = prev.map((t) => (freshById.has(t.id) ? freshById.get(t.id) : t));
            const existingIds = new Set(prev.map((t) => t.id));
            const newOnes = fresh.filter((t) => !existingIds.has(t.id));
            const next = [...newOnes, ...kept];
            persistTxs(next);
            totalNew += newOnes.length;
            totalUpdated += fresh.length - newOnes.length;
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
          ? `${totalNew}件の新しい取引を取得しました(既存${totalUpdated}件も最新データで更新、${rows.length}アドレス分)`
          : `新しい取引はありませんでした(既存${totalUpdated}件を最新データで更新しました)`
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
      .sort((a, b) => {
        // 日時が無い取引は末尾に回す(nullが混ざると比較が壊れて並びが乱れるため)
        if (!a.date && !b.date) return 0;
        if (!a.date) return 1;
        if (!b.date) return -1;
        if (a.date === b.date) return 0;
        return a.date < b.date ? 1 : -1;
      });
  }, [txs, chainFilter, walletFilter]);

  const [pageSize, setPageSize] = useState(100);
  const [visibleCount, setVisibleCount] = useState(100);
  useEffect(() => {
    setVisibleCount(pageSize);
  }, [chainFilter, walletFilter, pageSize]);

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
            Ethereumは<strong>Etherscan APIキー</strong>(V2 API、無料枠あり)、Solanaは
            <strong>Helius APIキー</strong>(無料枠あり)を使います。BNB ChainはEtherscanが無料プランから除外したため、
            代わりに<strong>MegaNode(BSCTrace)APIキー</strong>(無料枠あり)を使います。
            <strong>Birdeye APIキー</strong>(無料枠あり)は、取引履歴の銘柄にコントラクトアドレスを登録して当時の時価を反映する機能で使います。
            どれもブラウザに保存されるだけで、サーバーには送信されません。
            Suiは公式GraphQLエンドポイントを直接使うため、APIキーは不要です。
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Etherscan APIキー(ETH用)</label>
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
          <div style={styles.fieldRow}>
            <label style={styles.label}>MegaNode APIキー(BNB Chain用)</label>
            <input
              style={styles.input}
              type="password"
              value={keyDraft.meganode}
              onChange={(e) => setKeyDraft((s) => ({ ...s, meganode: e.target.value }))}
              placeholder="nodereal.ioで発行したAPIキーを貼り付け"
            />
          </div>
          <div style={styles.fieldRow}>
            <label style={styles.label}>Birdeye APIキー(時価取得用)</label>
            <input
              style={styles.input}
              type="password"
              value={keyDraft.birdeye}
              onChange={(e) => setKeyDraft((s) => ({ ...s, birdeye: e.target.value }))}
              placeholder="birdeye.soで発行したAPIキーを貼り付け"
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
          <button
            style={{ ...styles.modeBtn, borderColor: `${COLORS.loss}55`, color: COLORS.loss }}
            onClick={() => clearChainData(activeChain)}
          >
            {CHAINS[activeChain].label}のデータを削除
          </button>
          {activeChain === "sol" && (
            <button
              style={{ ...styles.modeBtn, opacity: fetching ? 0.6 : 1 }}
              disabled={fetching}
              onClick={fixSolanaSymbols}
            >
              銘柄名を再解決(保存済みデータを修正)
            </button>
          )}
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

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 11, color: COLORS.textDim }}>表示件数:</span>
          {[30, 50, 100].map((n) => (
            <button
              key={n}
              onClick={() => setPageSize(n)}
              style={{ ...styles.modeBtn, fontSize: 11, padding: "5px 10px", ...(pageSize === n ? styles.modeBtnActive : {}) }}
            >
              {n}件
            </button>
          ))}
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
                  {["日時", "チェーン", "ウォレット", "種別", "銘柄", "数量", "単価(当時)", "評価額(当時)", "相手アドレス", ""].map((h) => (
                    <th key={h} style={styles.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredTxs.slice(0, visibleCount).map((t) => {
                  const dayPrice = histPriceFor(t.chain, t.asset, t.date?.slice(0, 10));
                  const valueUsd = dayPrice !== null ? dayPrice * Math.abs(t.amount) : null;
                  return (
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
                    <td style={{ ...styles.td, fontSize: 12, color: COLORS.textDim }}>
                      {dayPrice !== null ? `$${dayPrice.toLocaleString("ja-JP", { maximumFractionDigits: 6 })}` : "—"}
                    </td>
                    <td style={{ ...styles.td, fontSize: 12, color: COLORS.textDim }}>
                      {valueUsd !== null ? `$${valueUsd.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}` : "—"}
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {filteredTxs.length > visibleCount && (
          <button
            style={{ ...styles.modeBtn, marginTop: 12, width: "100%", textAlign: "center" }}
            onClick={() => setVisibleCount((c) => c + pageSize)}
          >
            もっと見る(あと{filteredTxs.length - visibleCount}件)
          </button>
        )}
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>コントラクトアドレスから時価を取得</div>
        <div style={styles.note}>
          取引一覧に出てくる銘柄名(例: DEEP、WAL)とコントラクトアドレスを登録すると、取引があった日ごとの時価(USD)をBirdeyeから取得し、取引一覧に反映します。
        </div>
        <div style={styles.modeToggle}>
          {Object.entries(CHAINS).map(([key, c]) => (
            <button
              key={key}
              onClick={() => setActivePriceChain(key)}
              style={{ ...styles.modeBtn, ...(activePriceChain === key ? styles.modeBtnActive : {}) }}
            >
              {c.label}
            </button>
          ))}
        </div>

        {(contractPrices[activePriceChain] || []).map((row, idx) => (
          <div style={styles.fieldRow} key={idx}>
            <input
              style={{ ...styles.input, width: 90 }}
              value={row.symbol}
              onChange={(e) => updateContractPriceRow(activePriceChain, idx, "symbol", e.target.value)}
              placeholder="銘柄名(例: DEEP)"
            />
            <input
              style={{ ...styles.input, flex: 1 }}
              value={row.address}
              onChange={(e) => updateContractPriceRow(activePriceChain, idx, "address", e.target.value)}
              placeholder="コントラクトアドレス"
            />
            <button
              style={{ ...styles.btnPrimary, opacity: priceFetching ? 0.6 : 1, padding: "10px 12px" }}
              disabled={priceFetching}
              onClick={() => applyContractPrice(activePriceChain, row.symbol, row.address)}
              title="この銘柄の時価を反映"
            >
              {priceFetching ? <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} /> : <Coins size={16} />}
            </button>
            <button
              style={{ ...styles.iconBtn, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 10 }}
              onClick={() => removeContractPriceRow(activePriceChain, idx)}
              title="削除"
            >
              <span style={{ color: COLORS.loss, fontSize: 13 }}>✕</span>
            </button>
          </div>
        ))}

        <button style={{ ...styles.modeBtn, marginTop: 4 }} onClick={() => addContractPriceRow(activePriceChain)}>
          + 銘柄を追加
        </button>

        {priceError && <div style={styles.errorBanner}>{priceError}</div>}
        {!priceFetching && priceStatus && <div style={styles.successBanner}>{priceStatus}</div>}
      </div>

      <div style={styles.card}>
        <div style={styles.tableHeaderRow}>
          <div style={styles.cardTitle}>保有残高</div>
          <button
            style={{ ...styles.btnPrimary, opacity: holdingsFetching ? 0.6 : 1, padding: "8px 12px", fontSize: 12 }}
            disabled={holdingsFetching}
            onClick={fetchAllCurrentPrices}
          >
            {holdingsFetching ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <RefreshCw size={14} />}
            現在の時価を更新
          </button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
          <button
            style={{ ...styles.modeBtn, fontSize: 11, padding: "6px 10px", opacity: holdingsFetching ? 0.6 : 1 }}
            disabled={holdingsFetching}
            onClick={fetchOnchainBalances}
          >
            残高をチェーンから直接取得(Solana/Sui)
          </button>
          <button
            style={{ ...styles.modeBtn, fontSize: 11, padding: "6px 10px" }}
            onClick={() => setShowHiddenAssets((v) => !v)}
          >
            {showHiddenAssets ? "非表示の銘柄を隠す" : "非表示にした銘柄も表示"}
          </button>
        </div>
        {holdingsStatus && <div style={{ ...styles.note, marginBottom: 8 }}>{holdingsStatus}</div>}

        {pieData.slices.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 20 }}>
            <PieChart data={pieData.slices} colors={PIE_COLORS} />
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", justifyContent: "center", marginTop: 12 }}>
              {pieData.slices.map((s, i) => (
                <div key={s.asset} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: COLORS.textDim }}>
                  <span style={{ width: 9, height: 9, borderRadius: 9, background: PIE_COLORS[i % PIE_COLORS.length], display: "inline-block" }} />
                  {s.asset} {s.pct.toFixed(1)}%
                </div>
              ))}
            </div>
          </div>
        )}

        {holdingsRows.length === 0 ? (
          <div style={styles.emptyState}>まだ保有残高がありません。</div>
        ) : (
          <div style={styles.tableWrap}>
            <table style={styles.table}>
              <thead>
                <tr>
                  {["チェーン", "ウォレット", "銘柄", "保有数量", "評価額(現在)", ""].map((h) => (
                    <th key={h} style={styles.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {holdingsRows
                  .sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0))
                  .map((r) => {
                    const isHidden = !!hiddenAssets[r.key];
                    return (
                      <tr key={r.key} style={{ ...styles.tr, opacity: isHidden ? 0.5 : 1 }}>
                        <td style={styles.td}>
                          <span style={{ color: CHAINS[r.chain]?.color }}>{CHAINS[r.chain]?.label || r.chain}</span>
                        </td>
                        <td style={{ ...styles.td, fontSize: 11, color: COLORS.textDim }}>{walletLabel(r.chain, r.wallet)}</td>
                        <td style={{ ...styles.td, fontWeight: 600 }}>{r.asset}</td>
                        <td style={styles.td}>{fmtAmt(r.qty)}</td>
                        <td style={styles.td}>
                          {r.valueUsd !== null ? `$${r.valueUsd.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}` : "—"}
                        </td>
                        <td style={styles.td}>
                          {isHidden ? (
                            <button style={{ ...styles.modeBtn, fontSize: 11, padding: "4px 8px" }} onClick={() => unhideAsset(r.chain, r.wallet, r.asset)}>
                              再表示
                            </button>
                          ) : (
                            <button style={{ ...styles.modeBtn, fontSize: 11, padding: "4px 8px" }} onClick={() => hideAsset(r.chain, r.wallet, r.asset)}>
                              非表示
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
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

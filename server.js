const express = require("express");
const cors = require("cors");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

async function getEbayToken() {
  const credentials = Buffer.from(
    `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
  ).toString("base64");

  const response = await fetch(EBAY_TOKEN_URL, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
  });

  const data = await response.json();
  return data.access_token;
}

async function searchEbaySold(query, token) {
  const params = new URLSearchParams({
    q: query,
    filter: "buyingOptions:{FIXED_PRICE},conditions:{USED|VERY_GOOD|GOOD}",
    sort: "price",
    limit: "10",
  });

  const response = await fetch(`${EBAY_SEARCH_URL}?${params}`, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      "Content-Type": "application/json",
    },
  });

  const data = await response.json();

  if (!data.itemSummaries || data.itemSummaries.length === 0) {
    return { avgPrice: null, soldCount: 0 };
  }

  const prices = data.itemSummaries
    .filter(item => item.price)
    .map(item => parseFloat(item.price.value));

  if (prices.length === 0) return { avgPrice: null, soldCount: 0 };

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

  return {
    avgPrice: parseFloat(avg.toFixed(2)),
    soldCount: data.total || prices.length,
  };
}

function normalizeDescription(brand, description) {
  const cleaned = description
    .replace(/\bMNS\b/gi, "Men's")
    .replace(/\bLS\b/gi, "Long Sleeve")
    .replace(/\bBU\b/gi, "Button Up")
    .replace(/\bJKT\b/gi, "Jacket")
    .replace(/\bPNT\b/gi, "Pant")
    .replace(/\bSWT\b/gi, "Sweatshirt")
    .replace(/\bFLC\b/gi, "Fleece")
    .replace(/\bCRWNK\b/gi, "Crewneck")
    .replace(/\bFZ\b/gi, "Full Zip")
    .replace(/\bQZ\b/gi, "Quarter Zip")
    .replace(/\bBLK\b/gi, "Black")
    .replace(/\bWHT\b/gi, "White")
    .replace(/\bNVY\b/gi, "Navy");

  const brandClean = brand && brand !== "—" ? brand : "";
  const query = `${brandClean} ${cleaned}`.trim();
  return query.replace(/\b\d+[A-Z]{1,2}\b/g, "").replace(/\s+/g, " ").trim();
}

function parseManifestCSV(csvText) {
  const lines = csvText.split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];

  const delimiter = lines[0].includes("\t") ? "\t" : ",";
  const header = lines[0].split(delimiter).map(h => h.replace(/['"]/g, "").trim().toLowerCase());

  const colIndex = (names) => {
    for (const n of names) {
      const i = header.findIndex(h => h.includes(n));
      if (i !== -1) return i;
    }
    return -1;
  };

  const itemNumCol    = colIndex(["item #", "item#", "item number"]);
  const lotIdCol      = colIndex(["lot id", "lot_id"]);
  const palletIdCol   = colIndex(["pallet id", "pallet_id"]);
  const brandCol      = colIndex(["brand"]);
  const descCol       = colIndex(["description", "item desc", "desc"]);
  const qtyCol        = colIndex(["qty", "quantity", "units"]);
  const unitRetailCol = colIndex(["unit retail", "unit price", "retail price"]);
  const extRetailCol  = colIndex(["ext. retail", "ext retail", "extended"]);
  const conditionCol  = colIndex(["optoro condition", "condition"]);
  const subcatCol     = colIndex(["subcategory"]);
  const categoryCol   = colIndex(["seller category", "category"]);

  const items = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map(c => c.replace(/['"]/g, "").trim());
    if (cols.length < 3) continue;

    const description = descCol !== -1 ? cols[descCol] : "";
    const brand       = brandCol !== -1 ? cols[brandCol] : "";
    const qty         = qtyCol !== -1 ? parseInt(cols[qtyCol]) || 1 : 1;
    const unitRetail  = unitRetailCol !== -1 ? parseFloat(cols[unitRetailCol]) || 0 : 0;
    const extRetail   = extRetailCol !== -1 ? parseFloat(cols[extRetailCol]) || 0 : unitRetail * qty;
    const itemNumber  = itemNumCol !== -1 ? cols[itemNumCol] : "—";
    const lotId       = lotIdCol !== -1 ? cols[lotIdCol] : "—";
    const palletId    = palletIdCol !== -1 ? cols[palletIdCol] : "—";
    const condition   = conditionCol !== -1 ? cols[conditionCol] : "";
    const subcategory = subcatCol !== -1 ? cols[subcatCol] : "";
    const sellerCat   = categoryCol !== -1 ? cols[categoryCol] : "";

    if (!description && !brand) continue;

    items.push({
      itemNumber,
      lotId,
      palletId,
      brand,
      description,
      qty,
      unitRetail,
      extRetail,
      condition,
      subcategory,
      sellerCategory: sellerCat,
    });
  }

  return items
    .filter(i => i.extRetail > 0)
    .sort((a, b) => b.extRetail - a.extRetail)
    .slice(0, 50);
}

app.post("/parse", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const csvText = req.file.buffer.toString("utf-8");
  const items = parseManifestCSV(csvText);

  if (items.length === 0) {
    return res.status(400).json({ error: "Could not parse manifest. Check file format." });
  }

  const totalUnits = items.reduce((s, i) => s + i.qty, 0);
  const totalRetail = items.reduce((s, i) => s + i.extRetail, 0);
  const brands = [...new Set(items.map(i => i.brand).filter(Boolean))];

  res.json({
    items,
    summary: {
      totalLines: items.length,
      totalUnits,
      totalRetail: parseFloat(totalRetail.toFixed(2)),
      totalBrands: brands.length,
      topBrands: brands.slice(0, 5),
    }
  });
});

app.post("/analyze", async (req, res) => {
  const { items } = req.body;

  if (!items || !Array.isArray(items)) {
    return res.status(400).json({ error: "items array required" });
  }

  try {
    const token = await getEbayToken();
    const results = [];

    for (const item of items) {
      const query = normalizeDescription(item.brand, item.description);
      const ebayData = await searchEbaySold(query, token);

      let score = "red";
      if (ebayData.avgPrice) {
        const ratio = ebayData.avgPrice / item.unitRetail;
        if (ratio >= 0.7 && ebayData.soldCount >= 10) score = "green";
        else if (ratio >= 0.45 || ebayData.soldCount >= 5) score = "yellow";
      }

      results.push({
        ...item,
        ebayAvg: ebayData.avgPrice || 0,
        ebaySold: ebayData.soldCount,
        score,
        searchQuery: query,
      });

      await new Promise(r => setTimeout(r, 200));
    }

    res.json({ results });
  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => {
  res.json({ status: "LotLens API running", version: "1.0" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log("LotLens backend running on port " + PORT));
```

Commit con el mensaje:
```
fix: clean server.js full rewrite

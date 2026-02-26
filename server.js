const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
const EBAY_SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";

// Get eBay OAuth token (Client Credentials flow - no user login needed)
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

// Search eBay sold listings for a single item
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

// Normalize messy manifest descriptions using basic rules
// (Claude API integration goes here in v2)
function normalizeDescription(brand, description) {
  // Clean up common abbreviations
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

  // Build search query: brand + cleaned description
  const brandClean = brand && brand !== "—" ? brand : "";
  const query = `${brandClean} ${cleaned}`.trim();
  
  // Remove lot codes like "42S", "XL", size suffixes for better search
  return query.replace(/\b\d+[A-Z]{1,2}\b/g, "").replace(/\s+/g, " ").trim();
}

// Main endpoint: analyze a list of manifest items
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

      // Score the item based on eBay avg vs unit retail
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

      // Respect eBay rate limits: 5000 calls/day = ~1 call per 17s max
      // For burst usage we add a small delay between calls
      await new Promise(r => setTimeout(r, 200));
    }

    res.json({ results });
  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (req, res) => {
  res.json({ status: "LotLens API running", version: "1.0" });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`LotLens backend running on port ${PORT}`));

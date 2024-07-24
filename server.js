const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const app = express();

let AUCTION_DATA = {};
const CRAFTING_COSTS = {};
const ITEM_COSTS = {};
let NPC_COSTS = {};

app.use(express.static('public'));

async function getNumberOfAuctionsPagesAndIfUpdated() {
  const apiAuctionsUrl = 'https://api.hypixel.net/skyblock/auctions';
  const response = await axios.get(apiAuctionsUrl);
  const data = response.data;
  return { numberOfPages: data.totalPages, lastUpdated: data.lastUpdated };
}

async function getAuctions(page, reforgesList) {
  const apiAuctionsUrl = `https://api.hypixel.net/skyblock/auctions?page=${page}`;
  const response = await axios.get(apiAuctionsUrl);
  const auctions = response.data.auctions;

  for (const auction of auctions) {
    try {
      if (auction.bin) {
        let name = auction.item_name.toLowerCase();
        name = name.replace(/\[\w*\s\d*\]/g, '');
        name = name.replace(/\s\s+/g, ' ');
        name = name.replace(/[^\w\s]\W*$/, '');
        name = name.replace(/^\W\s/, '');
        reforgesList.forEach(reforge => {
          const regex = new RegExp(`\\b${reforge}\\b`, 'g');
          name = name.replace(regex, '');
        });
        name = name.trim();

        if (name === 'enchanted book') {
          let lore = auction.item_lore;
          let bookNames = lore.split('\n')[0].split(',');
          let legendaryEnchantment = false;

          for (let names of bookNames) {
            let enchantments = names.split('9');
            for (let enchantment of enchantments) {
              if (enchantment.includes('§l')) {
                name = enchantment.replace(/§d§l§7§l|,|\n/g, '').trim();
                legendaryEnchantment = true;
              }
            }
            if (!legendaryEnchantment) {
              if (enchantments.length > 1) {
                name = enchantments[1].replace(/§9§d§l§7§l|,|\n/g, '').trim();
              } else {
                name = enchantments[0].replace(/§9§d§l§7§l|,|\n/g, '').trim();
              }
            }
          }
          if (name.includes('Use this on') || name.length < 2) {
            continue;
          }
          name = name.trim();
        }

        if (!AUCTION_DATA[name]) {
          AUCTION_DATA[name] = [`${auction.starting_bid}|${auction.uuid}`];
        } else {
          AUCTION_DATA[name].push(`${auction.starting_bid}|${auction.uuid}`);
        }
      }
    } catch (e) {
      continue;
    }
  }
}

async function getBazaarPrices() {
  const apiBazaarUrl = 'https://api.hypixel.net/skyblock/bazaar';
  const response = await axios.get(apiBazaarUrl);
  const products = response.data.products;

  for (let key in products) {
    const item = products[key];
    const buyPrice = item.buy_summary.length ? item.buy_summary[0].pricePerUnit : 0;
    const sellPrice = item.sell_summary.length ? item.sell_summary[0].pricePerUnit : 0;
    ITEM_COSTS[key] = { buyPrice, sellPrice };
  }
}

async function getNPCPrices() {
  return {
    'dirt': 1,
    'cobblestone': 3,
    'oak_wood': 5,
  };
}

async function calculateCraftingCosts(recipes) {
  for (let item in recipes) {
    let totalCost = 0;
    for (let ingredient of recipes[item]) {
      const itemCost = ITEM_COSTS[ingredient.name] ? ITEM_COSTS[ingredient.name].buyPrice : (NPC_COSTS[ingredient.name] || 0);
      totalCost += itemCost * ingredient.quantity;
    }
    CRAFTING_COSTS[item] = totalCost;
  }
}

function findItemsToFlip(data) {
  let flipItems = {};

  for (let [key, value] of Object.entries(data)) {
    let product = value.map(item => {
      if (typeof item === 'string') {
        return parseFloat(item.split('|')[0]);
      } else {
        console.error(`Invalid item format for key ${key}:`, item);
        return NaN; // Возвращаем NaN для некорректных элементов
      }
    }).filter(p => !isNaN(p)); // Удаляем элементы, которые не являются числами

    let productsUuid = value.map(item => {
      if (typeof item === 'string') {
        return item.split('|')[1];
      } else {
        return null; // Возвращаем null для некорректных элементов
      }
    }).filter(uuid => uuid !== null); // Удаляем некорректные UUID

    if (product.every(p => p === product[0])) {
      continue;
    }

    let productNormalize = product.map(p => (p - Math.min(...product)) / (Math.max(...product) - Math.min(...product)));

    if (product.length > 1) {
      let madZscore, mad;
      [madZscore, mad] = MAD_Z_Score(productNormalize);

      let productMedian = product.reduce((a, b) => a + b, 0) / product.length;
      let productAnomalies = madZscore.map(score => score > 3);

      if (productAnomalies.filter(Boolean).length < 3) {
        let productSorted = [...product].sort((a, b) => a - b);
        for (let idx in productAnomalies) {
          if (productAnomalies[idx] && product[idx] < productMedian) {
            let outlier = product[idx];
            productSorted = productSorted.filter(p => p !== outlier);
            let cheapest = productSorted[0];
            let expensive = Math.max(...productSorted); // Исправлено для правильного расчета LBin
            let expectedProfit = expensive - cheapest;
            console.log(`Item: ${key}, Outlier: ${outlier}, Cheapest: ${cheapest}, Expensive: ${expensive}, Expected Profit: ${expectedProfit}`); // Логирование
            if (expectedProfit > 0) { // Only consider items with a positive expected profit
              flipItems[key] = [outlier, cheapest, expectedProfit, product.length, productsUuid[idx]];
            }
          }
        }
      }
    }
  }

  let itemsToFlipDataset = Object.entries(flipItems).map(([key, value]) => ({
    'Item Name': key,
    'Hunted Price': value[0],
    'LBin': value[1],
    'Expected Profit': value[2],
    'Items on market': value[3],
    'Auction uuid': value[4],
  }));

  itemsToFlipDataset.sort((a, b) => b['Expected Profit'] - a['Expected Profit']);

  AUCTION_DATA.flipItems = itemsToFlipDataset; // Save flip items to AUCTION_DATA
}


function MAD_Z_Score(data, consistencyCorrection = 1.4826) {
  let median = data.reduce((a, b) => a + b, 0) / data.length;
  let deviationFromMed = data.map(d => Math.abs(d - median));
  let MAD = deviationFromMed.reduce((a, b) => a + b, 0) / deviationFromMed.length;

  if (MAD !== 0) {
    let MAD_zscore = deviationFromMed.map(d => d / (consistencyCorrection * MAD));
    return [MAD_zscore, MAD];
  } else {
    return [Array(data.length).fill(0), 0];
  }
}

function writeDataToCSV(data, filename) {
  const filePath = path.join(__dirname, filename);
  const headers = Object.keys(data[0]).join(',');
  const rows = data.map(item => Object.values(item).join(','));

  const csvContent = [headers, ...rows].join('\n');
  fs.writeFileSync(filePath, csvContent, 'utf8');
}

async function fetchAllItemPrices() {
  await getBazaarPrices();
  NPC_COSTS = await getNPCPrices();

  const recipes = await getCraftingRecipes();
  await calculateCraftingCosts(recipes);

  const combinedData = [];
  for (const item in ITEM_COSTS) {
    const npcCost = NPC_COSTS[item] || 0;
    const craftingCost = CRAFTING_COSTS[item] || 0;

    const { buyPrice, sellPrice } = ITEM_COSTS[item];
    combinedData.push({
      'Item Name': item,
      'Bazaar Buy Price': buyPrice,
      'Bazaar Sell Price': sellPrice,
      'NPC Cost': npcCost,
      'Crafting Cost': craftingCost,
    });
  }

  writeDataToCSV(combinedData, 'public/item_prices.csv');
}

async function getCraftingRecipes() {
  return {
    'enchanted_cobblestone': [
      { name: 'cobblestone', quantity: 160 },
    ],
  };
}

async function main() {
  const reforgesList = ["Sharp", "Spicy", "Legendary"];
  const { numberOfPages, lastUpdated } = await getNumberOfAuctionsPagesAndIfUpdated();

  for (let page = 0; page < numberOfPages; page++) {
    await getAuctions(page, reforgesList);
  }

  findItemsToFlip(AUCTION_DATA);
  await fetchAllItemPrices();

  // Save auction data to JSON file
  const auctionFilePath = path.join(__dirname, 'public', 'auctions.json');
  fs.writeFileSync(auctionFilePath, JSON.stringify(AUCTION_DATA, null, 2), 'utf8');
}

function startUpdating(interval = 60000) {
  main().catch(console.error);
  setInterval(() => {
    main().catch(console.error);
  }, interval);
}

startUpdating();

app.get('/api/auctions', (req, res) => {
  res.json(AUCTION_DATA);
});

app.listen(3000, () => {
  console.log('Server is running on http://localhost:3000');
});

const axios = require('axios');
const fs = require('fs');
const path = require('path');

let AUCTION_DATA = {};
let last_updated_old = 0;
const CRAFTING_COSTS = {};
const ITEM_COSTS = {};
let NPC_COSTS = {};

// Функция для форматирования чисел в человекочитаемый формат
function humanFormat(num) {
  let magnitude = 0;
  while (Math.abs(num) >= 1000) {
    magnitude += 1;
    num /= 1000.0;
  }
  return `${num.toFixed(2)}${['', 'K', 'M', 'B', 'T'][magnitude]}`;
}

// Функция для получения количества страниц аукционов и проверки обновления
async function getNumberOfAuctionsPagesAndIfUpdated() {
  const apiAuctionsUrl = 'https://api.hypixel.net/skyblock/auctions';
  const response = await axios.get(apiAuctionsUrl);
  const data = response.data;
  const numberOfPages = data.totalPages;
  if (numberOfPages > 120) {
    throw new Error('Abusing hypixel API');
  }
  const lastUpdated = data.lastUpdated;
  return { numberOfPages, lastUpdated };
}

// Функция для получения последнего времени обновления
async function getLastUpdated() {
  const apiAuctionsUrl = 'https://api.hypixel.net/skyblock/auctions';
  const response = await axios.get(apiAuctionsUrl);
  const data = response.data;
  return data.lastUpdated;
}

// Функция для получения аукционов на основе параметров
async function getAuctions(page, reforgesList) {
  const apiAuctionsUrl = `https://api.hypixel.net/skyblock/auctions?page=${page}`;
  const response = await axios.get(apiAuctionsUrl);
  const auctions = response.data.auctions;

  for (const auction of auctions) {
    try {
      if (auction.bin) {
        let name = auction.item_name.toLowerCase();
        name = name.replace(/\[\w*\s\d*\]/g, ''); // [lvl xx]
        name = name.replace(/\s\s+/g, ' '); // двойные пробелы в один
        name = name.replace(/[^\w\s]\W*$/, ''); // *** в конце имени
        name = name.replace(/^\W\s/, ''); // странные символы в начале имени
        reforgesList.forEach(reforge => {
          const regex = new RegExp(`\\b${reforge}\\b`, 'g');
          name = name.replace(regex, ''); // удаление reforges
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

// Функция для получения цен на предметы с рынка
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

// Функция для получения цен на предметы от NPC
async function getNPCPrices() {
  // Эта функция должна содержать логику получения цен на предметы от NPC
  // Для простоты предположим, что она возвращает объект с примерами цен
  return {
    'dirt': 1,
    'cobblestone': 3,
    'oak_wood': 5,
  };
}

// Функция для расчета затрат на крафт
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

// Функция для поиска предметов для флипа
function findItemsToFlip(data) {
  let flipItems = {};

  for (let [key, value] of Object.entries(data)) {
    let product = value.map(item => parseFloat(item.split('|')[0]));
    let productsUuid = value.map(item => item.split('|')[1]);

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
            let expectedProfit = cheapest - outlier;
            flipItems[key] = [outlier, cheapest, expectedProfit, product.length, productsUuid[idx]];
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
  console.table(itemsToFlipDataset);

  AUCTION_DATA = {};
}

// Функция для расчета MAD Z Score
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

// Функция для записи данных в CSV
function writeDataToCSV(data, filename) {
  const filePath = path.join(__dirname, filename);
  const headers = Object.keys(data[0]).join(',');
  const rows = data.map(item => Object.values(item).join(','));

  const csvContent = [headers, ...rows].join('\n');
  fs.writeFileSync(filePath, csvContent, 'utf8');
}

// Функция для получения и хранения всех цен на предметы
async function fetchAllItemPrices() {
  await getBazaarPrices();
  NPC_COSTS = await getNPCPrices();

  // Получение рецептов крафта (предполагается функция `getCraftingRecipes`, которая возвращает список рецептов)
  const recipes = await getCraftingRecipes();

  await calculateCraftingCosts(recipes);

  // Создание комбинированного объекта данных
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

  writeDataToCSV(combinedData, 'item_prices.csv');
}

// Функция для получения рецептов крафта (пример)
async function getCraftingRecipes() {
  // Эта функция должна быть заменена на реальную логику получения рецептов
  return {
    'enchanted_cobblestone': [
      { name: 'cobblestone', quantity: 160 },
    ],
    // Добавьте больше рецептов здесь
  };
}

// Основная функция для выполнения всего процесса
async function main() {
  const reforgesList = ["Sharp", "Spicy", "Legendary"]; // Добавьте больше reforges, если нужно
  const { numberOfPages, lastUpdated } = await getNumberOfAuctionsPagesAndIfUpdated();

  for (let page = 0; page < numberOfPages; page++) {
    await getAuctions(page, reforgesList);
  }

  findItemsToFlip(AUCTION_DATA);

  await fetchAllItemPrices();
}

// Функция для запуска основной функции с интервалом
function startUpdating(interval = 60000) {
  main().catch(console.error);
  setInterval(() => {
    main().catch(console.error);
  }, interval);
}

startUpdating(); // Начать процесс с интервалом по умолчанию 60 секунд

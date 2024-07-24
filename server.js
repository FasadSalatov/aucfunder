const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const app = express();

let AUCTION_DATA = {};
const CRAFTING_COSTS = {};
const ITEM_COSTS = {};
let NPC_COSTS = {};
let lastUpdated = 0;
let updateInterval = 10000; // 10 секунд по умолчанию
let updateIntervalId;
let chatIds = []; // Массив для хранения chatId пользователей
let minProfit = 0; // Минимальная прибыль по умолчанию

// Telegram Bot Configuration
const telegramBotToken = '7242966791:AAF8ZpBUxwsdItJZloDCh7smGxT90SANOWY';
const bot = new TelegramBot(telegramBotToken, { polling: true });

app.use(express.static('public'));

// Helper function to handle API requests
async function fetchAPI(url) {
  try {
    const response = await axios.get(url);
    return response.data;
  } catch (error) {
    console.error(`Ошибка при запросе ${url}:`, error.message);
    return null;
  }
}

async function getNumberOfAuctionsPagesAndIfUpdated() {
  const data = await fetchAPI('https://api.hypixel.net/skyblock/auctions');
  if (data) {
    return { numberOfPages: data.totalPages, lastUpdated: data.lastUpdated };
  }
  return { numberOfPages: 0, lastUpdated: lastUpdated };
}

async function getAuctions(page, reforgesList) {
  const data = await fetchAPI(`https://api.hypixel.net/skyblock/auctions?page=${page}`);
  if (data && data.auctions) {
    for (const auction of data.auctions) {
      try {
        if (auction.bin) {
          let name = auction.item_name.toLowerCase();
          name = name.replace(/\[\w*\s\d*\]/g, '')
                     .replace(/\s\s+/g, ' ')
                     .replace(/[^\w\s]\W*$/, '')
                     .replace(/^\W\s/, '')
                     .trim();

          reforgesList.forEach(reforge => {
            const regex = new RegExp(`\\b${reforge}\\b`, 'g');
            name = name.replace(regex, '');
          });
          
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
          }

          if (!AUCTION_DATA[name]) {
            AUCTION_DATA[name] = [`${auction.starting_bid}|${auction.uuid}|${auction.end}`];
          } else {
            AUCTION_DATA[name].push(`${auction.starting_bid}|${auction.uuid}|${auction.end}`);
          }
        }
      } catch (e) {
        console.error('Ошибка обработки аукциона:', e.message);
      }
    }
  }
}

async function getBazaarPrices() {
  const data = await fetchAPI('https://api.hypixel.net/skyblock/bazaar');
  if (data && data.products) {
    for (let key in data.products) {
      const item = data.products[key];
      const buyPrice = item.buy_summary.length ? item.buy_summary[0].pricePerUnit : 0;
      const sellPrice = item.sell_summary.length ? item.sell_summary[0].pricePerUnit : 0;
      ITEM_COSTS[key] = { buyPrice, sellPrice };
    }
  }
}

async function getNPCPrices() {
  const data = await fetchAPI('https://api.hypixel.net/skyblock/npc');
  if (data && data.npcs) {
    let npcPrices = {};
    for (const npc of data.npcs) {
      npcPrices[npc.item] = npc.price;
    }
    return npcPrices;
  }
  return {};
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
    let product = value.map(item => parseFloat(item.split('|')[0])).filter(p => !isNaN(p));
    let productsUuid = value.map(item => item.split('|')[1]).filter(uuid => uuid !== null);

    if (product.every(p => p === product[0])) {
      continue;
    }

    let productNormalize = product.map(p => (p - Math.min(...product)) / (Math.max(...product) - Math.min(...product)));

    if (product.length > 1) {
      let [madZscore, mad] = MAD_Z_Score(productNormalize);

      let productMedian = product.reduce((a, b) => a + b, 0) / product.length;
      let productAnomalies = madZscore.map(score => score > 3);

      if (productAnomalies.filter(Boolean).length < 3) {
        let productSorted = [...product].sort((a, b) => a - b);
        for (let idx in productAnomalies) {
          if (productAnomalies[idx] && product[idx] < productMedian) {
            let outlier = product[idx];
            productSorted = productSorted.filter(p => p !== outlier);
            let cheapest = productSorted[0];
            let expensive = Math.max(...productSorted);
            let expectedProfit = expensive - cheapest;

            if (expectedProfit > minProfit) { // Фильтр по минимальной прибыли
              flipItems[key] = [outlier, cheapest, expectedProfit, product.length, productsUuid[idx]];
              notifyTelegram(key, expectedProfit, outlier, cheapest, productsUuid[idx]);
            }
          }
        }
      }
    }
  }

  AUCTION_DATA.flipItems = Object.entries(flipItems).map(([key, value]) => ({
    'Item Name': key,
    'Hunted Price': formatNumber(value[0]),
    'LBin': formatNumber(value[1]),
    'Expected Profit': formatNumber(value[2]),
    'Items on market': value[3],
    'Auction uuid': value[4],
  })).sort((a, b) => b['Expected Profit'] - a['Expected Profit']);
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

function formatNumber(num) {
  return new Intl.NumberFormat().format(num);
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

  let recipes = {}; // Должны быть загружены откуда-то
  await calculateCraftingCosts(recipes);

  let combinedData = [];
  for (const item in ITEM_COSTS) {
    const npcCost = NPC_COSTS[item] || 0;
    const craftingCost = CRAFTING_COSTS[item] || 0;
    const buyPrice = ITEM_COSTS[item].buyPrice;
    const sellPrice = ITEM_COSTS[item].sellPrice;

    combinedData.push({
      'Item Name': item,
      'NPC Cost': npcCost,
      'Crafting Cost': craftingCost,
      'Bazaar Buy Price': buyPrice,
      'Bazaar Sell Price': sellPrice
    });
  }

  writeDataToCSV(combinedData, 'item_prices.csv');
}

async function processAuctions() {
  let pageData = await getNumberOfAuctionsPagesAndIfUpdated();
  if (pageData.lastUpdated > lastUpdated) {
    AUCTION_DATA = {};
    for (let page = 0; page < pageData.numberOfPages; page++) {
      await getAuctions(page, []); // Замени [] на список рефоджев
    }
    findItemsToFlip(AUCTION_DATA);
    lastUpdated = pageData.lastUpdated;
  }
}

function notifyTelegram(item, profit, outlier, cheapest, uuid) {
  const message = `🎯 **Item Name:** ${item}\n📉 **Hunted Price:** ${formatNumber(outlier)}\n💰 **LBin:** ${formatNumber(cheapest)}\n📈 **Expected Profit:** ${formatNumber(profit)}\n🔗 **Auction UUID:** ${uuid}`;
  chatIds.forEach(chatId => bot.sendMessage(chatId, message, { parse_mode: 'Markdown' }));
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (!chatIds.includes(chatId)) {
    chatIds.push(chatId);
  }
  bot.sendMessage(chatId, 'Добро пожаловать! Подписка на уведомления активирована.');
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `Привет! Вот доступные команды:
/start - Подписаться на уведомления
/help - Показать это сообщение
/status - Проверить статус бота
/update - Обновить данные и запустить процесс поиска аукционов
/list - Показать список доступных предметов и их цен
/flip - Показать наиболее выгодные предметы для покупки и перепродажи
/interval - Установить интервал обновлений данных (в миллисекундах)
/startinterval - Запустить автоматическое обновление данных
/stopinterval - Остановить автоматическое обновление данных
/minprofit - Установить минимальную прибыль для фильтрации`;
  bot.sendMessage(chatId, helpMessage);
});

bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const statusMessage = `Бот активен. Последнее обновление данных произошло: ${new Date(lastUpdated).toLocaleString()}.`;
  bot.sendMessage(chatId, statusMessage);
});

bot.onText(/\/update/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    await fetchAllItemPrices();
    await processAuctions();
    bot.sendMessage(chatId, 'Данные обновлены и процесс поиска аукционов запущен.');
  } catch (error) {
    console.error('Ошибка обновления данных:', error.message);
    bot.sendMessage(chatId, 'Произошла ошибка при обновлении данных.');
  }
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  const itemsList = Object.keys(AUCTION_DATA).map(item => `• ${item}`).join('\n');
  bot.sendMessage(chatId, `Доступные предметы:\n${itemsList}`);
});

bot.onText(/\/flip/, (msg) => {
  const chatId = msg.chat.id;
  const flipItemsList = AUCTION_DATA.flipItems || [];
  if (flipItemsList.length > 0) {
    const message = flipItemsList.map(item => `🎯 **Item Name:** ${item['Item Name']}\n📉 **Hunted Price:** ${item['Hunted Price']}\n💰 **LBin:** ${item['LBin']}\n📈 **Expected Profit:** ${item['Expected Profit']}\n🔗 **Auction UUID:** ${item['Auction uuid']}`).join('\n\n');
    bot.sendMessage(chatId, `**Наиболее выгодные предметы для покупки и перепродажи:**\n\n${message}`, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, 'Нет доступных предметов для перепродажи в данный момент.');
  }
});

bot.onText(/\/interval (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const interval = parseInt(match[1], 10);
  if (!isNaN(interval) && interval > 0) {
    updateInterval = interval;
    bot.sendMessage(chatId, `Интервал обновлений установлен на ${interval} миллисекунд.`);
  } else {
    bot.sendMessage(chatId, 'Пожалуйста, укажите корректное значение интервала в миллисекундах.');
  }
});

bot.onText(/\/startinterval/, (msg) => {
  const chatId = msg.chat.id;
  if (updateIntervalId) {
    bot.sendMessage(chatId, 'Автоматическое обновление уже запущено.');
    return;
  }
  updateIntervalId = setInterval(async () => {
    try {
      await fetchAllItemPrices();
      await processAuctions();
    } catch (error) {
      console.error('Ошибка автоматического обновления:', error.message);
    }
  }, updateInterval);
  bot.sendMessage(chatId, 'Автоматическое обновление данных запущено.');
});

bot.onText(/\/stopinterval/, (msg) => {
  const chatId = msg.chat.id;
  if (updateIntervalId) {
    clearInterval(updateIntervalId);
    updateIntervalId = null;
    bot.sendMessage(chatId, 'Автоматическое обновление данных остановлено.');
  } else {
    bot.sendMessage(chatId, 'Автоматическое обновление данных не запущено.');
  }
});

bot.onText(/\/minprofit (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const profit = parseFloat(match[1]);
  if (!isNaN(profit) && profit >= 0) {
    minProfit = profit;
    bot.sendMessage(chatId, `Минимальная прибыль установлена на ${formatNumber(profit)}.`);
  } else {
    bot.sendMessage(chatId, 'Пожалуйста, укажите корректное значение минимальной прибыли.');
  }
});

app.listen(3000, () => {
  
});

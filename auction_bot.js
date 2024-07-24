const axios = require('axios');
const { Worker, isMainThread, parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');

// Placeholder for global variables
let AUCTION_DATA = {};
let last_updated_old = 0;

// Function to format numbers in a human-readable format
function humanFormat(num) {
  let magnitude = 0;
  while (Math.abs(num) >= 1000) {
    magnitude += 1;
    num /= 1000.0;
  }
  return `${num.toFixed(2)}${['', 'K', 'M', 'B', 'T'][magnitude]}`;
}

// Function to get number of auction pages and check if updated
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

// Function to get the last updated timestamp
async function getLastUpdated() {
  const apiAuctionsUrl = 'https://api.hypixel.net/skyblock/auctions';
  const response = await axios.get(apiAuctionsUrl);
  const data = response.data;
  return data.lastUpdated;
}

// Function to get auctions based on parameters
async function getAuctions(itemName, price, page, reforgesList, matches, lore = '', flipperMode = true) {
  const apiAuctionsUrl = 'https://api.hypixel.net/skyblock/auctions';
  const response = await axios.get(apiAuctionsUrl, { params: { page } });
  const auctions = response.data.auctions;

  for (const auction of auctions) {
    if (!flipperMode) {
      if (auction.item_name.toLowerCase().includes(itemName) && !auction.claimed && auction.item_lore.includes(lore)) {
        try {
          if (auction.bin && auction.starting_bid < price) {
            console.log(itemName, 'price:', auction.starting_bid);
          }
        } catch (e) {
          continue;
        }
      }
    } else {
      try {
        if (auction.bin) {
          let name = auction.item_name.toLowerCase();
          name = name.replace(/\[\w*\s\d*\]/g, ''); // [lvl xx]
          name = name.replace(/\s\s+/g, ' '); // double spaces to one
          name = name.replace(/[^\w\s]\W*$/, ''); // *** at the end of the name
          name = name.replace(/^\W\s/, ''); // this weird umbrella ect at the beginning
          reforgesList.forEach(reforge => {
            const regex = new RegExp(`\\b${reforge}\\b`, 'g');
            name = name.replace(regex, ''); // deleting reforges
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
}

// Function to find items to flip
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

// Function to calculate MAD Z Score
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

// Main function to check auctions
async function checkAuctions(reforgesList, matches = [], id) {
  const { numberOfPages, lastUpdated } = await getNumberOfAuctionsPagesAndIfUpdated();
  if (lastUpdated === last_updated_old) {
    return;
  }

  let promises = [];
  for (let page = 0; page < numberOfPages; page++) {
    promises.push(getAuctions('', 0, page, reforgesList, matches));
  }

  await Promise.all(promises);
  let data = AUCTION_DATA;
  findItemsToFlip(data);
  last_updated_old = lastUpdated;

  console.log(`Thread #${id} has finished its job`);
}

// Main execution
(async () => {
  let reforgesList = fs.readFileSync('reforges.csv', 'utf8').split('\n').map(line => line.toLowerCase().trim());

  let agents = [];
  let threadCounter = 0;

  while (true) {
    console.log('Creating new thread');
    threadCounter += 1;
    agents.push(checkAuctions(reforgesList, [], threadCounter));
    await agents[agents.length - 1];
    await new Promise(resolve => setTimeout(resolve, 35000));
  }
})();

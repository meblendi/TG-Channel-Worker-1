export default {
  async fetch(request, env, ctx) {
    try {
      const response = await handleRequest(env);
      return response; // Return the response to the client
    } catch (error) {
      console.error("Error in fetch handler:", error);
      return new Response("An error occurred: " + error.message, { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    try {
      ctx.waitUntil(handleRequest(env)); // Ensure async work completes
    } catch (error) {
      console.error("Error in scheduled handler:", error);
    }
  },
};

async function handleRequest(env) {
  const wsUrl = 'wss://wss.nobitex.ir/connection/websocket';

  const symbols = [
    { symbol: "USDTIRT", title: "تتر", unit: "تومن", factor: 0.1 },
    { symbol: "BTCIRT", title: "بیتکوین", unit: "تومن", factor: 0.1 },
    { symbol: "BTCUSDT", title: "بیتکوین", unit: "دلار", factor: 1 },
    { symbol: "ETHIRT", title: "اتریوم", unit: "تومن", factor: 0.1 },
    { symbol: "ETHUSDT", title: "اتریوم", unit: "دلار", factor: 1 },
  ];

  const tgBotToken = '7921890394:AAErf6ISrgZ71_MmXSJZSRpw4eJon1MPjuA';
  const tgChannel = '@irancurrency_price';

  const sendToTelegram = async (messages) => {
    const tgApiUrl = `https://api.telegram.org/bot${tgBotToken}/sendMessage`;
    const body = {
      chat_id: tgChannel,
      text: messages.join("\n"),
    };

    try {
      const response = await fetch(tgApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        console.error("Failed to send message to Telegram:", await response.text());
      }
    } catch (error) {
      console.error("Error sending message to Telegram:", error);
    }
  };

  const savePriceToKV = async (key, price) => {
    await env.price_link.put(key, price.toString());
  };

  const getLastPriceFromKV = async (key) => {
    const lastPrice = await env.price_link.get(key);
    return lastPrice ? parseFloat(lastPrice) : null;
  };

  const saveYesterdayPriceToKV = async (key, price) => {
    await env.price_link.put(`${key}_yesterday`, price.toString(), { expirationTtl: 86400 }); // Store for 24 hours
  };

  const getYesterdayPriceFromKV = async (key) => {
    const lastPrice = await env.price_link.get(`${key}_yesterday`);
    return lastPrice ? parseFloat(lastPrice) : null;
  };

  const messages = [];

  for (const { symbol, title, unit, factor } of symbols) {
    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          ws.send(
            JSON.stringify({
              connect: { name: 'js' },
              id: 3,
            })
          );
          ws.send(
            JSON.stringify({
              subscribe: {
                channel: `public:orderbook-${symbol}`,
                recover: true,
                offset: 0,
                epoch: '0',
                delta: 'fossil',
              },
              id: 4,
            })
          );
        };

        ws.onmessage = async (event) => {
          try {
            const message = JSON.parse(event.data);
            if (message.id === 4 && message.subscribe && message.subscribe.publications) {
              const publication = message.subscribe.publications[0];
              if (publication && publication.data) {
                const parsedData = JSON.parse(publication.data);
                if (parsedData.asks && parsedData.asks.length > 0) {
                  let currentPrice = parsedData.asks[0][0] * factor;

                  const lastPrice = await getLastPriceFromKV(symbol);
                  const yesterdayPrice = await getYesterdayPriceFromKV(symbol);
                  let trend = '';
                  let percentageChange = '';

                  if (lastPrice !== null) {
                    trend = currentPrice > lastPrice ? '🔼' : currentPrice < lastPrice ? '🔻' : '⏺️';
                  }

                  if (yesterdayPrice !== null) {
                    const change = currentPrice - yesterdayPrice;
                    percentageChange = ((change / yesterdayPrice) * 100).toFixed(2) + '%';
                  }

                  await savePriceToKV(symbol, currentPrice);
                  if (yesterdayPrice === null) {
                    await saveYesterdayPriceToKV(symbol, currentPrice);
                  }

                  const formattedNumber = new Intl.NumberFormat('en-US').format(currentPrice);
                  messages.push(`${trend} ${title}: ${formattedNumber} ${unit} (${percentageChange})`);

                  ws.close();
                  resolve();
                }
              }
            }
          } catch (error) {
            console.error(`Error parsing message for ${symbol}:`, error);
            ws.close();
            reject();
          }
        };

        ws.onerror = (error) => {
          console.error(`WebSocket error for ${symbol}:`, error);
          reject();
        };

        ws.onclose = () => {
          console.log(`WebSocket connection closed for ${symbol}.`);
        };
      });
    } catch (error) {
      console.error(`Error processing symbol ${symbol}:`, error);
    }
  }

  if (messages.length > 0) {
    await sendToTelegram(messages);
  }

  return new Response(`Messages sent to Telegram for ${symbols.length} symbols.`);
}

const http = require('http');
const fsp = require('fs/promises'); // Використовуємо fs.promises
const fs = require('fs'); // Для синхронної перевірки/створення директорії при старті
const path = require('path');
const { program } = require('commander');
const superagent = require('superagent');

// --- 1. Налаштування Commander ---
program
  .requiredOption('-h, --host <host>', 'Hostname for the server')
  .requiredOption('-p, --port <port>', 'port number for the server', parseInt)
  .requiredOption('-c, --cache <cache>', 'cache directory path')
  .parse(process.argv);

const options = program.opts();
const host = options.host;
const port = options.port;
const Cache_DIR = path.resolve(options.cache);

// --- 2. Створення кеш-директорії (Синхронно при старті) ---
try {
  if (!fs.existsSync(Cache_DIR)) {
    fs.mkdirSync(Cache_DIR, { recursive: true });
    console.log(`[INFO] Створено кеш-директорію: ${Cache_DIR}`);
  } else {
    console.log(`[INFO] Використовується існуюча кеш-директорія: ${Cache_DIR}`);
  }
} catch (err) {
  console.error(`[ERROR] Не вдалося створити кеш-директорію: ${err.message}`);
  process.exit(1);
}

// --- 3. Допоміжна функція для отримання тіла запиту (для PUT) ---
/**
 * Асинхронно зчитує тіло запиту і повертає його як Buffer.
 * @param {http.IncomingMessage} req - Об'єкт запиту
 * @returns {Promise<Buffer>}
 */
function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    const bodyChunks = [];
    req.on('data', (chunk) => {
      bodyChunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(bodyChunks));
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

// --- 4. Створення HTTP Сервера ---
const server = http.createServer(async (req, res) => {
  // Парсимо URL, щоб отримати код (наприклад, /200 -> "200")
  // Регулярний вираз ^\/\d{3}$ означає: рядок починається з /, 
  // за яким ідуть рівно 3 цифри, і на цьому рядок закінчується.
  const match = req.url.match(/^\/(\d{3})$/);

  if (!match) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Невірний формат URL. Очікується /<код_статусу>, наприклад /200');
    return;
  }

  const statusCode = match[1];
  const filePath = path.join(Cache_DIR, `${statusCode}.jpeg`);
  console.log(`[REQUEST] ${req.method} ${req.url}`);

  try {
    switch (req.method) {
      // --- GET: Отримати картинку ---
      case 'GET':
        try {
          // 1. Спробувати прочитати з кешу
          const fileData = await fsp.readFile(filePath);
          console.log(`[CACHE HIT] Віддаю ${statusCode} з кешу.`);
          res.writeHead(200, { 'Content-Type': 'image/jpeg' });
          res.end(fileData);
        } catch (cacheError) {
          // 2. Якщо в кеші немає (ENOENT - Error NO ENTry)
          if (cacheError.code === 'ENOENT') {
            console.log(`[CACHE MISS] Файл ${statusCode} не знайдено. Роблю запит до https://http.cat/${statusCode}`);
            try {
              // 3. Робимо запит до http.cat
              const httpCatUrl = `https://http.cat/${statusCode}`;
              const response = await superagent
                .get(httpCatUrl)
                .responseType('blob'); // 'blob' каже superagent повернути Buffer

              const imageData = response.body;

              // 4. Зберігаємо в кеш АСИНХРОННО
              await fsp.writeFile(filePath, imageData);
              console.log(`[CACHE SET] Збережено ${statusCode} в кеш.`);

              // 5. Віддаємо картинку користувачу
              res.writeHead(200, { 'Content-Type': 'image/jpeg' });
              res.end(imageData);
            } catch (fetchError) {
              // 6. Якщо http.cat повернув помилку (наприклад, 404 для коду 999)
              console.error(`[FETCH ERROR] Не вдалося отримати ${statusCode} з http.cat: ${fetchError.message}`);
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
              res.end('Not Found: Зображення не знайдено ні в кеші, ні на http.cat.');
            }
          } else {
            // Інша помилка читання файлу (наприклад, права доступу)
            throw cacheError;
          }
        }
        break;

      // --- PUT: Записати/оновити картинку ---
      case 'PUT':
        const requestBody = await getRequestBody(req);
        await fsp.writeFile(filePath, requestBody);
        console.log(`[WRITE] Зображення для коду ${statusCode} збережено/оновлено.`);
        res.writeHead(201, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`[Created] Зображення для коду ${statusCode} збережено.`);
        break;

      // --- DELETE: Видалити картинку ---
      case 'DELETE':
        try {
          await fsp.unlink(filePath);
          console.log(`[DELETE] Зображення для коду ${statusCode} видалено.`);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(`[OK] Зображення для коду ${statusCode} видалено.`);
        } catch (deleteError) {
          // Якщо файлу і так не було
          if (deleteError.code === 'ENOENT') {
            console.log(`[DELETE FAIL] Зображення ${statusCode} не знайдено в кеші.`);
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found: Зображення не знайдено в кеші.');
          } else {
            throw deleteError;
          }
        }
        break;

      // --- Інші методи ---
      default:
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method Not Allowed');
    }
  } catch (error) {
    // Загальний обробник помилок (наприклад, помилка EACCES - відмовлено в доступі)
    console.error(`[SERVER ERROR] ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
  }
});

// --- 5. Запуск Сервера ---
server.listen(port, host, () => {
  console.log(`[INFO] Сервер успішно запущено на http://${host}:${port}`);
});
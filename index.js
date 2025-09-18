import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import { request } from 'undici';
import cliProgress from 'cli-progress';
import minimist from 'minimist';
import archiver from 'archiver';

// CLI引数処理
const args = minimist(process.argv.slice(2));
const magazineId = args.magazineId;
const volumeOnly = args['volume-only'] || false;
const volumeDigits = parseInt(args['volume-digits']) || 2;
const useZip = args.zip || false;

if (!magazineId) {
  console.error('Usage: bun index.js --magazineId=<id> [--volume-only] [--volume-digits=<n>] [--zip]');
  process.exit(1);
}

// マガジン記事一覧取得関数
async function getMagazineArticles(magazineId) {
  const articles = [];
  let page = 1;
  let isLastPage = false;

  while (!isLastPage) {
    const url = `https://note.com/api/v1/layout/magazine/${magazineId}/section?page=${page}&include_details=true`;
    try {
      const { body, statusCode } = await request(url, {
        headers: {
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://note.com/',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (statusCode !== 200) {
        console.error(`HTTP ${statusCode} on page ${page}`);
        break;
      }

      const data = await body.json();

      if (data.data && data.data.section && data.data.section.contents) {
        const contentsCount = data.data.section.contents.length;
        if (contentsCount > 0) {
          console.log(`Page ${page}: found ${contentsCount} contents`);
          for (const content of data.data.section.contents) {
            if (content.note_url) {
              // magazine_keyをクエリパラメータとして追加
              let fullUrl = content.note_url;
              if (content.key) {
                const separator = content.note_url.includes('?') ? '&' : '?';
                fullUrl = `${content.note_url}${separator}magazine_key=${content.key}`;
              }
              articles.push(fullUrl);
            }
          }
        } else {
          // 空のページが続く場合、終了
          isLastPage = true;
          break;
        }
      }

      isLastPage = data.is_last_page || false;
      page++;

      // レート制限対策で少し待つ
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.error(`Error fetching page ${page}:`, error.message);
      break; // エラー時は停止
    }
  }

  return articles;
}

// 記事メタデータ取得関数
async function getArticleMetadata(noteUrl) {
  let magazineKey = '';

  if (noteUrl.includes('?magazine_key=')) {
    const [queryPart] = noteUrl.split('?');
    const queryParams = new URLSearchParams(queryPart);
    magazineKey = queryParams.get('magazine_key') || '';
  }
  const noteUrlEncoded = encodeURIComponent(`${noteUrl}?magazine_key=${magazineKey}`);
  // magazine_keyパラメータを常に追加
  const url = `https://note.com/api/v2/metadata/${noteUrlEncoded}`;

  try {
    const { body, statusCode } = await request(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://note.com/',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });

    if (statusCode !== 200) {
      console.error(`HTTP ${statusCode} for metadata ${noteId}`);
      return { title: 'Untitled', images: [] };
    }

    const data = await body.json();

    let title = 'Untitled'; // デフォルト
    const images = [];

    if (data.data) {
      if (data.data.title) {
        title = data.data.title;
      }
      if (data.data.structuredData) {
        for (const item of data.data.structuredData) {
          if (item['@context'] === 'https://schema.org/' && item['@type'] === 'ImageObject') {
            if (item.contentUrl) {
              images.push(item.contentUrl);
            }
          }
        }
      }
    }
    return { title, images };
  } catch (error) {
    console.error(`Error fetching metadata for ${noteId}:`, error.message);
    return { title: 'Untitled', images: [] };
  }
}

// 画像ダウンロード関数
async function downloadImage(url, filePath, retries = 3) {
  // ファイルが存在する場合はスキップ
  if (existsSync(filePath)) {
    return true;
  }

  for (let i = 0; i < retries; i++) {
    try {
      const { body, statusCode } = await request(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://note.com/',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      });

      if (statusCode !== 200) {
        console.error(`HTTP ${statusCode} for image ${url}`);
        if (i === retries - 1) return false;
        continue;
      }

      const buffer = await body.arrayBuffer();
      await writeFile(filePath, Buffer.from(buffer));
      return true;
    } catch (error) {
      console.error(`Download failed for ${url} (attempt ${i + 1}):`, error.message);
      if (i === retries - 1) {
        return false;
      }
      // リトライ前に少し待つ
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return false;
}

// 画像をzipファイルに追加する関数
async function addImageToZip(url, zipFileName, imageName, archive, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const { body, statusCode } = await request(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://note.com/',
          'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      });

      if (statusCode !== 200) {
        console.error(`HTTP ${statusCode} for image ${url}`);
        if (i === retries - 1) return false;
        continue;
      }

      const buffer = await body.arrayBuffer();
      archive.append(Buffer.from(buffer), { name: imageName });
      return true;
    } catch (error) {
      console.error(`Download failed for ${url} (attempt ${i + 1}):`, error.message);
      if (i === retries - 1) {
        return false;
      }
      // リトライ前に少し待つ
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  return false;
}

// zipファイルを作成する関数
async function createZipFile(zipPath, images, title) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', {
      zlib: { level: 9 } // 最高圧縮
    });

    output.on('close', () => {
      resolve();
    });

    archive.on('error', (err) => {
      reject(err);
    });

    archive.pipe(output);

    // 画像をzipに追加
    images.forEach((imageUrl, index) => {
      const imageName = `${(index + 1).toString().padStart(3, '0')}.jpg`;
      archive.append(null, { name: imageName });
      // 実際の画像データは後で追加
    });

    archive.finalize();
  });
}

// フォルダ名を安全にする関数
function sanitizeFolderName(name) {
  if (volumeOnly) {
    // 巻数表示のみの場合（整数・小数の両方に対応）
    const patterns = [
      /第(\d+(?:\.\d+)?)巻/g,  // 第○○巻（○○は整数または小数）
      /第(\d+(?:\.\d+)?)話/g,  // 第○○話（○○は整数または小数）
      /(\d+(?:\.\d+)?)巻/g,    // ○○巻（○○は整数または小数）
      /(\d+(?:\.\d+)?)話/g     // ○○話（○○は整数または小数）
    ];

    for (const pattern of patterns) {
      const match = pattern.exec(name);
      if (match) {
        const number = match[1];
        const prefix = match[0].startsWith('第') ? '第' : '';
        const suffix = match[0].includes('巻') ? '巻' : '話';

        // 小数を含む場合はそのまま、整数のみの場合は0埋め
        if (number.includes('.')) {
          return `${prefix}${number}${suffix}`;
        } else {
          const paddedNumber = number.padStart(volumeDigits, '0');
          return `${prefix}${paddedNumber}${suffix}`;
        }
      }
    }
    // パターンが見つからない場合は元の名前を使用
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
  }

  // 通常の処理
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

// メイン処理
async function main() {
  console.log(`Starting download for magazine ID: ${magazineId}`);
  if (useZip) {
    console.log('Using ZIP mode - files will be compressed into ZIP archives');
  }

  const articles = await getMagazineArticles(magazineId);
  console.log(`Found ${articles.length} articles.`);

  const allImages = [];
  const articleData = [];

  // 各記事のメタデータを取得
  for (const noteUrl of articles) {
    const { title, images } = await getArticleMetadata(noteUrl);
    if (images.length > 0) {
      articleData.push({ title, images });
      allImages.push(...images);
    }
  }

  console.log(`Total images to download: ${allImages.length}`);

  if (allImages.length === 0) {
    console.log('No images found.');
    return;
  }

  // 進捗バー
  const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  progressBar.start(allImages.length, 0);

  let downloadedCount = 0;

  // ダウンロードディレクトリ作成
  const baseDir = join('downloads', magazineId.toString());
  await mkdir(baseDir, { recursive: true });

  if (useZip) {
    // ZIPモード
    for (const { title, images } of articleData) {
      const sanitizedTitle = sanitizeFolderName(title);
      const zipPath = join(baseDir, `${sanitizedTitle}.zip`);

      // ZIPファイルが存在する場合はスキップ
      if (existsSync(zipPath)) {
        downloadedCount += images.length;
        progressBar.update(downloadedCount);
        continue;
      }

      try {
        const output = createWriteStream(zipPath);
        const archive = archiver('zip', {
          zlib: { level: 9 } // 最高圧縮
        });

        await new Promise((resolve, reject) => {
          output.on('close', () => {
            resolve();
          });

          archive.on('error', (err) => {
            reject(err);
          });

          archive.pipe(output);

          // 画像を順次追加
          let imageIndex = 0;
          const addNextImage = async () => {
            if (imageIndex >= images.length) {
              archive.finalize();
              return;
            }

            const imageUrl = images[imageIndex];
            const imageName = `${(imageIndex + 1).toString().padStart(3, '0')}.jpg`;

            const success = await addImageToZip(imageUrl, zipPath, imageName, archive);
            if (success) {
              downloadedCount++;
              progressBar.update(downloadedCount);
            } else {
              console.error(`Failed to add ${imageUrl} to ZIP`);
            }

            imageIndex++;
            addNextImage();
          };

          addNextImage();
        });
      } catch (error) {
        console.error(`Error creating ZIP for ${sanitizedTitle}:`, error.message);
      }
    }
  } else {
    // 通常モード（フォルダ作成）
    // 各記事の画像をダウンロード
    for (const { title, images } of articleData) {
      const sanitizedTitle = sanitizeFolderName(title);
      const articleDir = join(baseDir, sanitizedTitle);
      await mkdir(articleDir, { recursive: true });

      for (let i = 0; i < images.length; i++) {
        const imageUrl = images[i];
        const fileName = `${(i + 1).toString().padStart(3, '0')}.jpg`;
        const filePath = join(articleDir, fileName);

        const success = await downloadImage(imageUrl, filePath);
        if (success) {
          downloadedCount++;
          progressBar.update(downloadedCount);
        } else {
          console.error(`Failed to download ${imageUrl}`);
        }
      }
    }
  }

  progressBar.stop();
  console.log('Download completed.');
}

main().catch(console.error);
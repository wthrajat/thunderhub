import { app, BrowserWindow, shell } from 'electron';
import path from 'path';
import { randomBytes } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';

let mainWindow: BrowserWindow | null = null;

const isDev = !app.isPackaged;

const getOrCreateEncryptionKey = (userDataPath: string): string => {
  const keyPath = path.join(userDataPath, 'encryption-key');
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, 'utf8').trim();
  }
  const key = randomBytes(32).toString('hex');
  writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
};

const startNestServer = async (): Promise<string> => {
  const appPath = app.getAppPath();
  const userDataPath = app.getPath('userData');

  if (!existsSync(userDataPath)) {
    mkdirSync(userDataPath, { recursive: true });
  }

  process.env.NODE_ENV = 'production';
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';
  process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
  process.env.DB_SQLITE_PATH =
    process.env.DB_SQLITE_PATH || path.join(userDataPath, 'thunderhub.db');
  process.env.DB_ENCRYPTION_KEY =
    process.env.DB_ENCRYPTION_KEY || getOrCreateEncryptionKey(userDataPath);
  process.env.STATIC_ROOT_PATH = path.join(appPath, 'src', 'client', 'dist');
  process.env.DB_MIGRATIONS_PATH = path.join(appPath, 'drizzle');

  const { NestFactory } = await import('@nestjs/core');
  const helmetMod = await import('helmet');
  const helmet = helmetMod.default;
  const { WINSTON_MODULE_NEST_PROVIDER } = await import('nest-winston');
  const { AppModule } = await import(path.join(appPath, 'dist', 'app.module'));

  const nestApp = await NestFactory.create(AppModule);
  nestApp.useLogger(nestApp.get(WINSTON_MODULE_NEST_PROVIDER));

  nestApp.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'connect-src': ["'self'", 'wss://api.boltz.exchange'],
          'upgrade-insecure-requests': null,
        },
      },
    })
  );

  nestApp.setGlobalPrefix(process.env.BASE_PATH || '');

  await nestApp.listen(0, '127.0.0.1');
  const url = await nestApp.getUrl();
  console.log(`[electron] NestJS listening at ${url}`);
  return url;
};

const createWindow = (url: string) => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  mainWindow.loadURL(url);

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

const bootstrap = async () => {
  try {
    const url = await startNestServer();
    createWindow(url);
  } catch (err) {
    console.error('[electron] Failed to start:', err);
    app.quit();
  }
};

app.whenReady().then(bootstrap);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    bootstrap();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

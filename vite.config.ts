import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Everything the UI reads comes from the CPA Manager Plus (Full Mode) Manager Server. It also
 * forwards any other `/v0/management/*` call to CLIProxyAPI with its stored management key, so the
 * browser only ever talks to this origin. Proxying keeps requests same-origin, which means the page
 * works unchanged on loopback, the LAN, or a Tailscale hostname without touching the Manager's
 * CORS allow-list.
 */
const MANAGER_PATHS = ['/v0', '/usage-service', '/health', '/status'];

function managerProxy(target: string): Record<string, ProxyOptions> {
  const options: ProxyOptions = {
    target,
    changeOrigin: true,
    // Live request streams can stay open for a long time.
    timeout: 0,
    proxyTimeout: 0,
    configure: (proxy) => {
      proxy.on('proxyReq', (proxyReq, req) => {
        // A same-origin Origin (e.g. https://usage.<tailnet>.ts.net) means nothing to the Manager and
        // could trip its CORS allow-list, so drop it. Cross-site Origins are left in place.
        const origin = req.headers.origin;
        if (!origin) return;
        try {
          const originHost = new URL(origin).host;
          const hosts = [req.headers.host, req.headers['x-forwarded-host']].flat().filter(Boolean);
          if (hosts.includes(originHost)) proxyReq.removeHeader('origin');
        } catch {
          // Malformed Origin: let the Manager decide.
        }
      });
    },
  };
  return Object.fromEntries(MANAGER_PATHS.map((path) => [path, options]));
}

function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const port = Number(env.PORT || 18320);
  const managerUrl = env.MANAGER_URL || 'http://127.0.0.1:18317';

  // Tailscale: listen on every interface (or HOST) and accept MagicDNS / Tailscale Serve hostnames
  // such as `mac-mini.tailXXXX.ts.net`. Tailnet IPs (100.x) need no entry; Vite always allows IPs.
  const host = env.HOST || '0.0.0.0';
  const allowedHosts = ['localhost', '127.0.0.1', '.ts.net', '.local', ...csv(env.ALLOWED_HOSTS)];

  // Behind `tailscale serve` (HTTPS on 443) the HMR socket must dial 443, not the dev port.
  const hmrClientPort = env.HMR_CLIENT_PORT ? Number(env.HMR_CLIENT_PORT) : undefined;

  return {
    plugins: [react()],
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      host,
      port,
      strictPort: true,
      allowedHosts,
      proxy: managerProxy(managerUrl),
      hmr: hmrClientPort ? { clientPort: hmrClientPort } : undefined,
    },
    preview: {
      host,
      port,
      strictPort: true,
      allowedHosts,
      proxy: managerProxy(managerUrl),
    },
    css: {
      modules: { localsConvention: 'camelCase', generateScopedName: '[name]__[local]___[hash:base64:5]' },
      preprocessorOptions: {
        // Ported CPAMC styles use these Sass variables without importing them.
        scss: { additionalData: `@use "@/styles/variables.scss" as *;` },
      },
    },
    build: {
      target: 'es2022',
      sourcemap: false,
      chunkSizeWarningLimit: 1200,
    },
  };
});

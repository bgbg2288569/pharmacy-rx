// 產生單檔試用版：npm install && npm run build → dist/處方寄單系統_試用版.html
// 用正式版 web/ 的程式，把 Supabase 換成瀏覽器內的模擬資料（demo-supabase.js）
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '../web');
const r = await build({
  entryPoints: [resolve(web, 'js/app.js')], bundle: true, minify: true, format: 'iife', write: false, charset: 'utf8',
  alias: { vue: 'vue/dist/vue.esm-bundler.js', '@supabase/supabase-js': resolve(here, 'demo-supabase.js') },
  nodePaths: [resolve(here, 'node_modules')],
  define: { __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false', __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false', 'process.env.NODE_ENV': '"production"' },
});
const js = r.outputFiles[0].text.replace(/<\/script/g, '<\\/script');
const css = readFileSync(resolve(web, 'css/app.css'), 'utf8');
const html = readFileSync(resolve(web, 'index.html'), 'utf8')
  .replace(/<script type="importmap">[\s\S]*?<\/script>\n/, '')
  .replace('<link rel="stylesheet" href="css/app.css">', () => `<style>\n${css}\n</style>`)
  .replace('<script type="module" src="js/app.js"></script>', () => `<script>\n${js}\n</script>`)
  .replace('<title>處方寄單系統 · 凌曜醫療</title>', '<title>處方寄單系統（試用版） · 凌曜醫療</title>');
mkdirSync(resolve(here, 'dist'), { recursive: true });
writeFileSync(resolve(here, 'dist/處方寄單系統_試用版.html'), html);
console.log('✓ dist/處方寄單系統_試用版.html');

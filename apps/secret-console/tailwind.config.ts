import type { Config } from 'tailwindcss';
import preset from '@autional/tailwind-preset';

/**
 * 设计系统令牌经 Tailwind preset 接入；content 必须包含 @autional/ui 的源码，
 * 否则它内部的 className（AppShell / SectionCard 等）会被 Purge 掉。
 */
const config: Config = {
  darkMode: 'class',
  presets: [preset],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './node_modules/@autional/ui/src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: { extend: {} },
  plugins: [],
};

export default config;

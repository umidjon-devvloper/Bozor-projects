/**
 * Light or dark, chosen or inherited.
 *
 * The class is applied by a blocking inline script before first paint (see `layout.tsx`). That
 * is a deliberate exception to "no scripts in the head": the alternative is a white flash on
 * every load for anyone who chose dark, which is worse on a phone in a covered bazaar than the
 * few milliseconds the script costs.
 */
export const THEME_COOKIE = 'bozorlar_theme';
export type Theme = 'light' | 'dark';

export const THEME_INIT_SCRIPT = `(function(){try{var m=document.cookie.match(/(?:^|; )${'bozorlar_theme'}=([^;]*)/);var t=m?m[1]:null;if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}if(t==='dark'){document.documentElement.classList.add('dark');}}catch(e){}})();`;

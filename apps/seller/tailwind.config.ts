import base from '../web/tailwind.config';
import type { Config } from 'tailwindcss';

/**
 * The seller dashboard borrows the marketplace's tokens and changes one thing: saffron leads
 * instead of teal.
 *
 * Both apps are the same platform seen from opposite sides of the stall, so a separate palette
 * would be a second brand to maintain for no gain. The accent swap is enough to tell a seller
 * which application they are looking at on a shared phone — which is the only thing the
 * difference has to do.
 */
export default {
  ...base,
  content: ['./src/**/*.{ts,tsx}'],
} satisfies Config;

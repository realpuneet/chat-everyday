/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: '#0b0b14', soft: '#121221', card: '#171728', raised: '#1e1e33' },
        brand: { 400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9' },
        accent: { 400: '#f472b6', 500: '#ec4899' },
      },
      fontFamily: { sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
      spacing: { 'safe-b': 'env(safe-area-inset-bottom)', 'safe-t': 'env(safe-area-inset-top)' },
      keyframes: {
        pulseRing: { '0%': { transform: 'scale(.8)', opacity: '.8' }, '100%': { transform: 'scale(2.2)', opacity: '0' } },
        dots: { '0%,80%,100%': { opacity: '.2' }, '40%': { opacity: '1' } },
      },
      animation: { pulseRing: 'pulseRing 1.8s ease-out infinite', dots: 'dots 1.2s infinite' },
    },
  },
  plugins: [],
};

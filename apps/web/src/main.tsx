import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadFonts } from './fonts';
import './styles.css';

loadFonts().finally(() => createRoot(document.getElementById('root')!).render(<App />));

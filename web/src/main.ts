import '@fontsource-variable/archivo/wdth.css';
import './styles.css';
import { BASE } from './api.ts';
import { renderLanding } from './landing.ts';
import { mountList } from './list.ts';

const root = document.getElementById('app')!;
const path = decodeURIComponent(location.pathname.startsWith(BASE) ? location.pathname.slice(BASE.length) : '').replace(/\/+$/, '');

if (path === '') renderLanding(root);
else mountList(root, path.toLowerCase());

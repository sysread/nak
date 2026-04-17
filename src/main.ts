import { mount } from 'svelte';
import App from './App.svelte';
import 'katex/dist/katex.min.css';
import './styles.css';

const target = document.getElementById('app');
if (!target) throw new Error('Missing #app root element.');

mount(App, { target });

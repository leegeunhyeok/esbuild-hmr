import { getMessage } from './sub';

console.log(getMessage());

document.getElementById('hmr_message').textContent = getMessage();
document.getElementById('hmr_date').textContent = new Date().toISOString();

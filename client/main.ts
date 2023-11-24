import { getMessage } from './sub';

export const initialize = () => {
  console.log(getMessage());
  document.getElementById('hmr_message').textContent = getMessage();
  document.getElementById('hmr_date').textContent = new Date().toISOString();
};

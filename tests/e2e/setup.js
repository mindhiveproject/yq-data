import { setup } from 'jest-dev-server';

const globalSetup = async () => {
  globalThis.servers = await setup({
      command: 'npm run dev --prefix ./demos', // or the command to start your server
    });
};

export default globalSetup;
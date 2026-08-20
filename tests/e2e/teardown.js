import { teardown } from "jest-dev-server";

const globalTeardown = async () => {
  await teardown(globalThis.servers);
};

export default globalTeardown;
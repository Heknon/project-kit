import pkg from "../package.json";

export const KIT_VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";

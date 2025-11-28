interface ImportMetaEnv {
  readonly VITE_API_KEY: string;
  readonly VITE_DEEPSEEK_API_KEY: string;
  readonly API_KEY?: string;
  readonly DEEPSEEK_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace NodeJS {
  interface ProcessEnv {
    API_KEY: string;
    DEEPSEEK_API_KEY: string;
    [key: string]: string | undefined;
  }
}
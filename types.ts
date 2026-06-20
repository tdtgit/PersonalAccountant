export type Environment = {
    readonly TELEGRAM_CHAT_ID: string;
    readonly TELEGRAM_BOT_TOKEN: string;
    readonly TELEGRAM_BOT_SECRET_TOKEN: string;

    readonly AI_API_GATEWAY: string;

    readonly OPENAI_PROJECT_ID: string;
    readonly OPENAI_API_KEY: string;

    readonly OPENAI_PROCESS_EMAIL_SYSTEM_PROMPT: string;
    readonly OPENAI_PROCESS_EMAIL_USER_PROMPT: string;
    readonly OPENAI_PROCESS_EMAIL_MODEL: string;
    readonly OPENAI_OCR_MODEL?: string;
    readonly OPENAI_ASSISTANT_MODEL?: string;
    readonly OPENAI_ASSISTANT_ROUTER_MODEL?: string;

    readonly OPENAI_ASSISTANT_VECTORSTORE_ID: string;
    readonly OPENAI_ASSISTANT_SCHEDULED_PROMPT: string;
};

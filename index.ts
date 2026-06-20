import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { dailyReport, handleAssistantRequest, monthlyReport, weeklyReport } from './assistant';
import { email } from './transactions';
import type { Environment } from './types';

export { buildMessageWithReplyContext, formatTransactionDetails, normalize, stripTelegramMarkdown } from './telegram';

const app = new Hono<{ Bindings: Environment }>();
app.use(logger());

app.post('/assistant', handleAssistantRequest);

export default {
    fetch: app.fetch,

    async scheduled(event, env: Environment) {
        switch (event.cron) {
            case "0 15 * * *":
                console.info("⏰ Daily scheduler triggered");
                await dailyReport(env);
                break;
            case "58 16 * * 0":
                console.info("⏰ Weekly scheduler triggered");
                await weeklyReport(env);
                break;
            case "0 15 1 * *":
                console.info("⏰ Monthly scheduler triggered");
                await monthlyReport(env);
                break;
        }
    },

    async email(message, env: Environment) {
        return email(message, env);
    }
};

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { dailyReport, handleAssistantRequest, monthlyReport, weeklyReport } from './handlers/assistant';
import { email as processEmail } from './handlers/transactions';
import type { Environment } from './types';

export { buildMessageWithReplyContext, convertCurrencyAmountsToVnd, formatCurrencyAmounts, formatTransactionDetails, normalize, stripTelegramMarkdown } from './services/telegram';

const app = new Hono<{ Bindings: Environment }>();
app.use('*', secureHeaders());
app.use('*', requestId());
app.use('*', logger());
app.use('*', prettyJSON());

app.get('/', (c) => c.json({
    ok: true,
    service: 'PersonalAccountant',
    runtime: 'Cloudflare Workers',
    framework: 'Hono',
}));
app.post('/assistant', handleAssistantRequest);
app.notFound((c) => c.json({ error: 'Not found' }, 404));
app.onError((error, c) => {
    console.error('Unhandled request error', error);
    return c.json({ error: 'Internal server error' }, 500);
});

export default {
    fetch: app.fetch,

    async scheduled(event, env: Environment, ctx: ExecutionContext) {
        switch (event.cron) {
            case "0 15 * * *":
                console.info("⏰ Daily scheduler triggered");
                await dailyReport(env);
                break;
            case "58 16 * * 1":
                console.info("⏰ Weekly scheduler triggered");
                await weeklyReport(env);
                break;
            case "0 15 1 * *":
                console.info("⏰ Monthly scheduler triggered");
                await monthlyReport(env);
                break;
        }
    },

    async email(message, env: Environment, ctx: ExecutionContext) {
        await processEmail(message, env);
    }
} satisfies ExportedHandler<Environment>;

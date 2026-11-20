// Referência para implementação do retorno do status dos provedores de serviços

const statusSchema = z.object({
    status: z.object({
        indicator: z.string(),
        description: z.string(),
    }),
});

const STATUS_URL = {
    github: 'https://githubstatus.com/api/v2/status.json',
    claudeflare: 'https://www.cloudflarestatus.com/api/v2/status.json',   
} as const;

async function fetchProviderStatus(provider: keyof typeof STATUS_URL, doFetch = fetch): Promise<string> {
for (let attempt = 1; attempt <= 2; attempt++) {
    try {
        const response = await doFetch(STATUS_URL[provider], {signal: AbortSignal.timeout(5000)});
        if (response.status >= 500){
            throw new Error(`upstream ${response.status}`);
        } if (response.ok) return `status page de ${provider} respondeu HTTP ${response.status}`;
        const { status } = statusSchema.parse(await response.json());
        return `${provider} está ${status.indicator} - ${status.description}`;
    } catch (error) {
        if (attempt === 2) {
            return `Falha ao obter status de ${provider}: ${error}
            Responda com base nos alertas internos e avise o plantonista da limitação `;
        }
    }
    return "unreachable";
}
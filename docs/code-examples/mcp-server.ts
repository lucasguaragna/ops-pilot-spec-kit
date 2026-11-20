import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';
import {SqliteOpsStore} from '../store/sqlite-ops-store.js';

const store = new SqliteOpsStore();
const server = new McpServer({
    name: 'opspilot',
    version: '1.0.0'
});

server.registerTool("open_incident", {
    description: 'Abre um novo incidente no OpsPilot. Use quando o usuário relatar um problema em produção ou pedir para abrir/registrar um incidente',
    inputSchema: {
        title: z.string().min(1).max(100).describe('Título do incidente'),
        service_id: z.string().min(1).max(50).describe('ID do serviço afetado'),
        severity: z.enum(['low', 'medium', 'high']).describe('Severidade do incidente'),

    },
},
async ({title, service_id, severity}) => ({
    content: [{type: "text", text: JSON.stringify(store.openIncident({title, service_id, severity}))}]
}));

// list_alerts e resolve_incident podem ser registrados de forma semelhante, usando server.registerTool com suas respectivas descrições e schemas de entrada.

await server.connect(new StdioServerTransport());
console.error("opspilot MCP server: pronto (stdio)"); //stderr, nunca stdout
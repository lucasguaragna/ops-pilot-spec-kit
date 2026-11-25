src/graph/production-graph.ts

const graph = new StateGraph(GraphState)
    .addNode("contexto", contextNode)
    .addNode("roteador", routerNode)
    .addNode("react", reactNode)
    .addNode("planExecute", planExecuteNode)
    .addNode("reflect", reflectNode)
    .addNode("resposta", answerNode)
    .addEdge("START", "contexto")
    .addConditionalEdges("roteador", (s) => s.route, {
        "react": "react",
        "planExecute": "planExecute",
        "reflect": "reflect",
    })
    .addEdge("react", "resposta")
    .addEdge("planExecute", "resposta")
    .addEdge("reflect", "resposta")
    .addEdge("resposta", "END");
    .compile();


// parte esquema

const routeSchema = z.object({
    route: z.enum(["react", "planExecute", "reflect"]),
    reason: z.string().describe("uma frase justificando a escolha"),
});

async function routerNode(state: typeof GraphState.State){
    const veredict = await createModel().withStructuredOutput(routeSchema).invoke([
        ["system", SYSTEM_PROMPT],
        ["user", state.input],
    ])
    trace.push({
        node: "roteador",
        type: "route",
        route: veredict.route,
        reason: veredict.reason,
    })
    return {route: veredict.route}
}
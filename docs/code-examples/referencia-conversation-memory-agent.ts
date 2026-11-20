// referencia do que o agente deve montar

export async function runChat(input: ChatInput){
    const conversationId = input.conversationId ?? conversations.create();
    //buscando as ultimas 12 mensagens do histórico de conversa
    const history = conversations.lastMessages(conversationId, 12);

    conversations.append(conversationsId, "user", input.message);
    const result = await strategy.run({message: input.message, history});
    conversations.append(conversationsId, "assistant", result.answer);

    return {conversationId, ...result, metrics: {...result.metrics, historyMessages: history.length}};
}
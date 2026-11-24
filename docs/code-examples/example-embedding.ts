// Referência para o Recall

async function recall(userId: string, query: string, k=3): Promise<Memory[]> {
    const q = await embed(query);
    return this._all(userId).map(mappedUser => ({...mapedUser, score: dot(q, mappedUser.embedding)})).sort((a, b) => b.score - a.score).slice(0, k).filter(mappedUser.score >0.3);

}
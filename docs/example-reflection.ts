// exemplo para implementação dentro do padrão de reflection

const vederictSchema = z.object({
  approved: z.boolean().optional(),
  feedback: z
    .string()
    .describe("se aprovado, o que corrigir em específico e acionável"),
});

async function critique(input: string, result: ReasoningResult) {
  return createModel()
    .withStructuredOutput(veredictSchema)
    .invoke([
      ["system", CRITIC_PROMPT], // avalie APENAS contra as observações do trace
      [
        "user",
        `Pedido: ${input}\nObservações: ${observationsOf(result.trace)}\nResposta: ${result.answer}`,
      ],
    ]);
}

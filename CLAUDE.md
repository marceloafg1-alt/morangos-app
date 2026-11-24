# Regras do projeto (Morangos Made in Roça)

- Web e mobile são o mesmo app (`index.html`): toda mudança vale para os dois.
- Sempre parta da `main` atual do GitLab (outras threads também editam `index.html`).
- **Paridade da IA:** tudo que o assistente de voz faz, o Lançar com IA também faz, e vice-versa. Toda ação nova entra no esquema compartilhado (`iaFerramenta` / `iaAcoesExtras`) e nas regras compartilhadas (`IA_ACOES_TXT`), nunca só em uma das portas.
- **Ajuda sempre atualizada:** toda função nova ou mudança de IA atualiza `AJ_G` (Configurações → Ajuda). O Chat de suporte lê `AJ_G`, então atualizar lá atualiza os dois.
- Responder em português e dizer o que foi testado só em navegador de desktop com voz/IA simuladas.

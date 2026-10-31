# Search benchmark

A small, reproducible check of how AlphainZ finds things, used for the table in the main README.

## The library

Six synthetic two-page papers in [`papers/`](papers), written for this benchmark: honeybee navigation,
sleep and memory, sourdough fermentation, news recommenders, urban heat, and a river delta. Each has two
figures, one per page. The studies, their data and their references are invented and say so in each
paper's footer.

Each `queries.json` holds six questions with their answer:

| kind | per paper | what it asks | answer |
|---|---|---|---|
| `text` | 2 English, 1 Chinese | the content of one sentence, without reusing its words | `target_quote`, `page` |
| `keyword` | 1 | two to four exact terms from one sentence | `target_quote`, `page` |
| `figure` | 1 English, 1 Chinese | what one figure looks like, without the caption's words | `figure`, `page` |

## How it was run

Zotero 10 with a development build of AlphainZ 0.1.78, the six papers imported with their metadata, and
every index built by the plugin itself. No language model is involved.

- **AlphainZ, text and keyword questions:** `POST /alphainz/test/semantic-search` with
  `{"query", "mode": "passages", "topK": 10}`. It runs the passage search the agent's tool uses: the
  best-matching passage of each PDF, ranked. The score is the rank of the paper holding the answer.
- **AlphainZ, figure questions:** `POST /alphainz/test/figure-search` with
  `{"provider", "query", "topK": 10, "perDocument": 2}` over the page images. The score is the rank of
  the page holding the figure, among all twelve pages.
- **Zotero's built-in search:** the quick search in "All Fields & Tags + Full Text" mode, the broadest
  one, after Zotero had indexed every PDF. A question counts as found when the paper is among the results.
  To reproduce, run this in Zotero's Tools → Developer → Run JavaScript, with `query` set:

  ```js
  const s = new Zotero.Search();
  s.libraryID = Zotero.Libraries.userLibraryID;
  s.addCondition('quicksearch-everything', 'contains', query);
  return (await s.search()).length;
  ```

The test endpoints exist only in development builds (`npm run build:dev`).

## Results

[`results/`](results) has every rank. Summary:

| Question | EmbeddingGemma 2 (Ollama) | Gemini Embedding 2 | Zotero's built-in search |
|---|:-:|:-:|:-:|
| Semantic search, English questions (12) | 12 of 12 best matches | 12 of 12 best matches | 0 of 12 |
| Semantic search, Chinese questions on English papers (6) | 6 of 6 best matches | 6 of 6 best matches | 0 of 6 |
| Describing a figure (12) | 5 best matches, 8 in the top 3 (MRR 0.57) | 6 best matches, 11 in the top 3 (MRR 0.71) | not possible |
| Exact keywords (6) | 5 of 6 best matches | 5 of 6 best matches | 6 of 6 |

Six papers make retrieval of text easy. The point of the text rows is the last column: a question asked in
other words, or in another language, gives keyword search nothing to match. Figure search is the hard
task: a page image holds a figure among a lot of text, and the two embedding models differ most there.

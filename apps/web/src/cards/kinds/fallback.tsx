import { Markdown } from "../../markdown";
import { Frame } from "../Frame";
import { defineCard } from "../registry";

/** A kind this app doesn't know yet (an older app, a newer host): show its title and any text. */
export default defineCard({
  kind: "fallback",
  render: ({ card, expanded }) => {
    const text = typeof card.data.text === "string" ? card.data.text : typeof card.data.summary === "string" ? card.data.summary : "";
    return (
      <Frame card={card} expanded={expanded}>
        <h3 className="c-title">{card.title}</h3>
        {text ? <Markdown text={text} /> : null}
      </Frame>
    );
  },
});

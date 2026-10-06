import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * A stored report rendered as the markdown it was written in — headings,
 * lists, tables, links — rather than line by line with the `##` and `-`
 * left standing. Imported lazily: only the research tab needs it.
 */
export default function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`prose-stock ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

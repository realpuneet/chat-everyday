import { useRef, useState, useCallback } from 'react';
import { Send } from 'lucide-react';
import clsx from 'clsx';

/** Message composer: Enter sends, Shift+Enter inserts a newline, grows up to 5 lines, throttled typing signal. */
export default function Composer({ onSend, onTyping, disabled, placeholder = 'Type a message…', max = 1000, leading, hint }) {
  const [text, setText] = useState('');
  const ref = useRef(null);
  const lastTyping = useRef(0);

  const grow = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }, []);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText('');
    lastTyping.current = 0; // next keystroke should announce typing again immediately
    onTyping?.(false);
    requestAnimationFrame(() => {
      grow();
      ref.current?.focus();
    });
  };

  return (
    <div className="border-t border-white/5 bg-bg-soft px-safe pb-safe pt-2">
      {hint && <p className="mb-1 text-center text-[11px] text-slate-500">{hint}</p>}
      <div className="flex items-end gap-2 pb-2">
        {leading}
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          id="composer"
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          maxLength={max}
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="on"
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            grow();
            const now = Date.now();
            if (onTyping && now - lastTyping.current > 2500) {
              lastTyping.current = now;
              onTyping(true);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="input max-h-32 min-h-[44px] flex-1 resize-none py-3 leading-snug"
        />
        <button onClick={submit} disabled={disabled || !text.trim()} className={clsx('btn-primary h-11 w-11 shrink-0 !p-0', !text.trim() && 'opacity-60')} aria-label="Send message">
          <Send className="h-5 w-5" aria-hidden="true" />
        </button>
      </div>
      {text.length > max * 0.85 && (
        <p className="pb-1 text-right text-[11px] text-slate-500" aria-live="polite">
          {text.length}/{max}
        </p>
      )}
    </div>
  );
}

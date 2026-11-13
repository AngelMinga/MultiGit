// Mensaje de un commit como en IntelliJ: el asunto (primera línea) en negrita y el cuerpo normal.
export function MessageBody(props: { text: string }) {
  const [subject = '', ...rest] = props.text.split('\n');
  return (
    <div className="detail-message">
      <strong>{subject}</strong>
      {rest.length > 0 && `\n${rest.join('\n')}`}
    </div>
  );
}

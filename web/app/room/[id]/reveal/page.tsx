import RevealView from "./RevealView";

export default async function RevealPage(props: PageProps<"/room/[id]/reveal">) {
  const { id } = await props.params;
  return <RevealView roomId={id} />;
}

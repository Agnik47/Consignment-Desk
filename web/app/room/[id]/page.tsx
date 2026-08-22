import RoomView from "./RoomView";

export default async function RoomPage(props: PageProps<"/room/[id]">) {
  const { id } = await props.params;
  return <RoomView roomId={id} />;
}

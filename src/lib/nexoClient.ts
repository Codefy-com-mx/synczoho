import nexo from "@tiendanube/nexo";
import { TIENDANUBE_APP_ID } from "@/lib/tiendanube";

const instance = nexo.create({
  clientId: TIENDANUBE_APP_ID,
  log: true,
});

export default instance;

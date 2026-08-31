import { useEffect, useState } from "react";
import { connect, getStoreInfo, iAmReady } from "@tiendanube/nexo";
import nexo from "@/lib/nexoClient";

type StoreInfo = Awaited<ReturnType<typeof getStoreInfo>>;

export function useNexo() {
  const [isEmbedded, setIsEmbedded] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [storeInfo, setStoreInfo] = useState<StoreInfo | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    if (window.self === window.top) {
      setChecked(true);
      return;
    }

    setIsEmbedded(true);
    connect(nexo, 5000)
      .then(async () => {
        setIsConnected(true);
        iAmReady(nexo);
        setStoreInfo(await getStoreInfo(nexo));
      })
      .catch((error) => {
        console.warn("Nexo connect failed:", error);
        setIsEmbedded(false);
      })
      .finally(() => setChecked(true));
  }, []);

  return { isEmbedded, isConnected, storeInfo, checked };
}

import { serve } from "../../runtime.js";
import { corsHeaders, getAdminClient } from "../_shared/zoho.js";
import { TN_USER_AGENT } from "../_shared/tiendanube.js";

export default serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { code } = await req.json();

    if (!code) {
      return new Response(
        JSON.stringify({ error: 'Authorization code is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const clientId = Deno.env.get('TIENDANUBE_CLIENT_ID');
    const clientSecret = Deno.env.get('TIENDANUBE_CLIENT_SECRET');

    if (!clientId || !clientSecret) {
      console.error('Missing Tiendanube credentials');
      return new Response(
        JSON.stringify({ error: 'Server configuration error' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('Exchanging code for access token...');

    const tokenResponse = await fetch('https://www.tiendanube.com/apps/authorize/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'authorization_code',
        code,
      }),
    });

    if (!tokenResponse.ok) {
      console.error('Token exchange failed:', tokenResponse.status);
      return new Response(
        JSON.stringify({ error: 'Failed to exchange authorization code' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const tokenData = await tokenResponse.json();

    const storeId = tokenData.user_id || tokenData.store_id || tokenData.id;

    if (!storeId) {
      return new Response(
        JSON.stringify({ error: 'No store ID returned from Tiendanube' }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Fetch store name
    const storeResponse = await fetch(`https://api.tiendanube.com/v1/${storeId}/store`, {
      headers: {
        'Authentication': `bearer ${tokenData.access_token}`,
        'User-Agent': TN_USER_AGENT,
        'Content-Type': 'application/json',
      },
    });

    let storeName = 'Mi Tienda';
    let storeHandle: string | null = null;
    if (storeResponse.ok) {
      const storeData = await storeResponse.json();
      storeName = storeData.name?.es || storeData.name?.en || storeData.name || 'Mi Tienda';
      storeHandle = storeData.original_domain || storeData.permalink || storeData.domain || null;
      console.log('Store name:', storeName);
      console.log('Store handle/domain:', storeHandle);
    }

    // Save to database
    const database = getAdminClient();

    const { data: existingStore } = await database
      .from('stores')
      .select('id')
      .eq('store_id', storeId.toString())
      .maybeSingle();

    if (existingStore) {
      const { error: updateError } = await database
        .from('stores')
        .update({
          access_token: tokenData.access_token,
          store_name: storeName,
        })
        .eq('store_id', storeId.toString());

      if (updateError) throw updateError;
      console.log('Store updated');
    } else {
      const { error: insertError } = await database
        .from('stores')
        .insert({
          store_id: storeId.toString(),
          access_token: tokenData.access_token,
          store_name: storeName,
        });

      if (insertError) throw insertError;
      console.log('Store inserted');
    }

    return new Response(
      JSON.stringify({
        success: true,
        store_id: storeId,
        store_name: storeName,
        store_handle: storeHandle,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Auth error:', error instanceof Error ? error.name : 'unknown');
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});

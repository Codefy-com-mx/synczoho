export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      customer_sync_map: {
        Row: {
          created_at: string
          email: string | null
          id: string
          last_error: string | null
          last_synced_at: string | null
          metadata: Json | null
          status: string
          store_id: string
          tiendanube_customer_id: number | null
          updated_at: string
          zoho_contact_id: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          metadata?: Json | null
          status?: string
          store_id: string
          tiendanube_customer_id?: number | null
          updated_at?: string
          zoho_contact_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          metadata?: Json | null
          status?: string
          store_id?: string
          tiendanube_customer_id?: number | null
          updated_at?: string
          zoho_contact_id?: string | null
        }
        Relationships: []
      }
      delivery_settings: {
        Row: {
          created_at: string
          cutoff_time: string
          id: string
          preparation_calc_mode: string
          preparation_max_days: number
          preparation_min_days: number
          shipping_calc_mode: string
          shipping_max_days: number
          shipping_min_days: number
          store_id: string
          updated_at: string
          user_id: string
          widget_enabled: boolean
          working_days: number[]
        }
        Insert: {
          created_at?: string
          cutoff_time?: string
          id?: string
          preparation_calc_mode?: string
          preparation_max_days?: number
          preparation_min_days?: number
          shipping_calc_mode?: string
          shipping_max_days?: number
          shipping_min_days?: number
          store_id: string
          updated_at?: string
          user_id: string
          widget_enabled?: boolean
          working_days?: number[]
        }
        Update: {
          created_at?: string
          cutoff_time?: string
          id?: string
          preparation_calc_mode?: string
          preparation_max_days?: number
          preparation_min_days?: number
          shipping_calc_mode?: string
          shipping_max_days?: number
          shipping_min_days?: number
          store_id?: string
          updated_at?: string
          user_id?: string
          widget_enabled?: boolean
          working_days?: number[]
        }
        Relationships: []
      }
      order_sync_map: {
        Row: {
          created_at: string
          id: string
          last_error: string | null
          last_synced_at: string | null
          payload: Json | null
          status: string
          store_id: string
          tiendanube_order_id: number
          updated_at: string
          zoho_invoice_id: string | null
          zoho_salesorder_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          payload?: Json | null
          status?: string
          store_id: string
          tiendanube_order_id: number
          updated_at?: string
          zoho_invoice_id?: string | null
          zoho_salesorder_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          payload?: Json | null
          status?: string
          store_id?: string
          tiendanube_order_id?: number
          updated_at?: string
          zoho_invoice_id?: string | null
          zoho_salesorder_id?: string | null
        }
        Relationships: []
      }
      product_delivery_settings: {
        Row: {
          created_at: string
          id: string
          preparation_max_days: number
          preparation_min_days: number
          product_id: number
          shipping_max_days: number
          shipping_min_days: number
          store_id: string
          updated_at: string
          working_days: number[]
        }
        Insert: {
          created_at?: string
          id?: string
          preparation_max_days?: number
          preparation_min_days?: number
          product_id: number
          shipping_max_days?: number
          shipping_min_days?: number
          store_id: string
          updated_at?: string
          working_days?: number[]
        }
        Update: {
          created_at?: string
          id?: string
          preparation_max_days?: number
          preparation_min_days?: number
          product_id?: number
          shipping_max_days?: number
          shipping_min_days?: number
          store_id?: string
          updated_at?: string
          working_days?: number[]
        }
        Relationships: []
      }
      product_sync_map: {
        Row: {
          created_at: string
          id: string
          last_error: string | null
          last_synced_at: string | null
          metadata: Json | null
          status: string
          store_id: string
          tiendanube_product_id: number | null
          updated_at: string
          zoho_item_id: string
          zoho_name: string | null
          zoho_sku: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          metadata?: Json | null
          status?: string
          store_id: string
          tiendanube_product_id?: number | null
          updated_at?: string
          zoho_item_id: string
          zoho_name?: string | null
          zoho_sku?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_synced_at?: string | null
          metadata?: Json | null
          status?: string
          store_id?: string
          tiendanube_product_id?: number | null
          updated_at?: string
          zoho_item_id?: string
          zoho_name?: string | null
          zoho_sku?: string | null
        }
        Relationships: []
      }
      products: {
        Row: {
          categories: Json | null
          created_at: string
          handle: Json | null
          id: string
          images: Json | null
          name: Json | null
          published: boolean | null
          store_id: string
          tiendanube_product_id: number
          updated_at: string
        }
        Insert: {
          categories?: Json | null
          created_at?: string
          handle?: Json | null
          id?: string
          images?: Json | null
          name?: Json | null
          published?: boolean | null
          store_id: string
          tiendanube_product_id: number
          updated_at?: string
        }
        Update: {
          categories?: Json | null
          created_at?: string
          handle?: Json | null
          id?: string
          images?: Json | null
          name?: Json | null
          published?: boolean | null
          store_id?: string
          tiendanube_product_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      stock_sync_state: {
        Row: {
          created_at: string
          id: string
          last_error: string | null
          last_qty: number | null
          last_source: string | null
          last_synced_at: string | null
          sku: string
          store_id: string
          tiendanube_product_id: number | null
          tiendanube_variant_id: number | null
          updated_at: string
          zoho_item_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_qty?: number | null
          last_source?: string | null
          last_synced_at?: string | null
          sku: string
          store_id: string
          tiendanube_product_id?: number | null
          tiendanube_variant_id?: number | null
          updated_at?: string
          zoho_item_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          last_error?: string | null
          last_qty?: number | null
          last_source?: string | null
          last_synced_at?: string | null
          sku?: string
          store_id?: string
          tiendanube_product_id?: number | null
          tiendanube_variant_id?: number | null
          updated_at?: string
          zoho_item_id?: string | null
        }
        Relationships: []
      }
      stores: {
        Row: {
          access_token: string
          created_at: string
          id: string
          status: string
          store_id: string
          store_name: string | null
          updated_at: string
          user_email: string | null
          user_id: string | null
        }
        Insert: {
          access_token: string
          created_at?: string
          id?: string
          status?: string
          store_id: string
          store_name?: string | null
          updated_at?: string
          user_email?: string | null
          user_id?: string | null
        }
        Update: {
          access_token?: string
          created_at?: string
          id?: string
          status?: string
          store_id?: string
          store_name?: string | null
          updated_at?: string
          user_email?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      sync_logs: {
        Row: {
          created_at: string
          duration_ms: number | null
          id: string
          message: string | null
          operation: string
          payload: Json | null
          status: string
          store_id: string
          tiendanube_product_id: number | null
          zoho_item_id: string | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          id?: string
          message?: string | null
          operation: string
          payload?: Json | null
          status: string
          store_id: string
          tiendanube_product_id?: number | null
          zoho_item_id?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          id?: string
          message?: string | null
          operation?: string
          payload?: Json | null
          status?: string
          store_id?: string
          tiendanube_product_id?: number | null
          zoho_item_id?: string | null
        }
        Relationships: []
      }
      sync_settings: {
        Row: {
          alert_email: string | null
          alert_on_error: boolean
          created_at: string
          customers_auto_sync_on_order: boolean
          id: string
          orders_auto_confirm: boolean
          orders_create_as_draft: boolean
          orders_enabled: boolean
          orders_generate_invoice_on_paid: boolean
          orders_only_paid: boolean
          products_match_strategy: string
          products_overwrite_existing: boolean
          products_publish_on_import: boolean
          products_sync_fields: Json
          prices_enabled: boolean
          prices_schedule: string
          stock_direction: string
          stock_enabled: boolean
          stock_priority: string
          stock_schedule: string
          stock_warehouse_id: string | null
          store_id: string
          updated_at: string
        }
        Insert: {
          alert_email?: string | null
          alert_on_error?: boolean
          created_at?: string
          customers_auto_sync_on_order?: boolean
          id?: string
          orders_auto_confirm?: boolean
          orders_create_as_draft?: boolean
          orders_enabled?: boolean
          orders_generate_invoice_on_paid?: boolean
          orders_only_paid?: boolean
          products_match_strategy?: string
          products_overwrite_existing?: boolean
          products_publish_on_import?: boolean
          products_sync_fields?: Json
          prices_enabled?: boolean
          prices_schedule?: string
          stock_direction?: string
          stock_enabled?: boolean
          stock_priority?: string
          stock_schedule?: string
          stock_warehouse_id?: string | null
          store_id: string
          updated_at?: string
        }
        Update: {
          alert_email?: string | null
          alert_on_error?: boolean
          created_at?: string
          customers_auto_sync_on_order?: boolean
          id?: string
          orders_auto_confirm?: boolean
          orders_create_as_draft?: boolean
          orders_enabled?: boolean
          orders_generate_invoice_on_paid?: boolean
          orders_only_paid?: boolean
          products_match_strategy?: string
          products_overwrite_existing?: boolean
          products_publish_on_import?: boolean
          products_sync_fields?: Json
          prices_enabled?: boolean
          prices_schedule?: string
          stock_direction?: string
          stock_enabled?: boolean
          stock_priority?: string
          stock_schedule?: string
          stock_warehouse_id?: string | null
          store_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      webhook_events: {
        Row: {
          created_at: string
          error_message: string | null
          event_type: string
          id: string
          payload: Json | null
          processed: boolean | null
          store_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          event_type: string
          id?: string
          payload?: Json | null
          processed?: boolean | null
          store_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          event_type?: string
          id?: string
          payload?: Json | null
          processed?: boolean | null
          store_id?: string
        }
        Relationships: []
      }
      widget_appearance_settings: {
        Row: {
          created_at: string
          id: string
          margin_bottom: number
          margin_left: number
          margin_right: number
          margin_top: number
          message_background_color: string
          message_border_color: string
          message_border_radius: number
          message_border_style: string
          message_border_width: number
          message_text_color: string
          progress_date_color: string
          progress_icon_bg_color: string
          progress_icon_color: string
          progress_line_color: string
          progress_title_color: string
          store_id: string
          updated_at: string
          user_id: string
          widget_mode: string
          widget_position: string
        }
        Insert: {
          created_at?: string
          id?: string
          margin_bottom?: number
          margin_left?: number
          margin_right?: number
          margin_top?: number
          message_background_color?: string
          message_border_color?: string
          message_border_radius?: number
          message_border_style?: string
          message_border_width?: number
          message_text_color?: string
          progress_date_color?: string
          progress_icon_bg_color?: string
          progress_icon_color?: string
          progress_line_color?: string
          progress_title_color?: string
          store_id: string
          updated_at?: string
          user_id: string
          widget_mode?: string
          widget_position?: string
        }
        Update: {
          created_at?: string
          id?: string
          margin_bottom?: number
          margin_left?: number
          margin_right?: number
          margin_top?: number
          message_background_color?: string
          message_border_color?: string
          message_border_radius?: number
          message_border_style?: string
          message_border_width?: number
          message_text_color?: string
          progress_date_color?: string
          progress_icon_bg_color?: string
          progress_icon_color?: string
          progress_line_color?: string
          progress_title_color?: string
          store_id?: string
          updated_at?: string
          user_id?: string
          widget_mode?: string
          widget_position?: string
        }
        Relationships: []
      }
      widget_text_settings: {
        Row: {
          created_at: string
          id: string
          message_template: string
          out_of_stock_message: string
          store_id: string
          today_label: string
          tomorrow_label: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          message_template?: string
          out_of_stock_message?: string
          store_id: string
          today_label?: string
          tomorrow_label?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          message_template?: string
          out_of_stock_message?: string
          store_id?: string
          today_label?: string
          tomorrow_label?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      zoho_connections: {
        Row: {
          access_token: string
          created_at: string
          dc: string
          id: string
          organization_id: string | null
          organization_name: string | null
          refresh_token: string
          scope: string | null
          status: string
          store_id: string
          token_expires_at: string
          updated_at: string
        }
        Insert: {
          access_token: string
          created_at?: string
          dc?: string
          id?: string
          organization_id?: string | null
          organization_name?: string | null
          refresh_token: string
          scope?: string | null
          status?: string
          store_id: string
          token_expires_at: string
          updated_at?: string
        }
        Update: {
          access_token?: string
          created_at?: string
          dc?: string
          id?: string
          organization_id?: string | null
          organization_name?: string | null
          refresh_token?: string
          scope?: string | null
          status?: string
          store_id?: string
          token_expires_at?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      stores_public: {
        Row: {
          created_at: string | null
          id: string | null
          status: string | null
          store_id: string | null
          store_name: string | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          status?: string | null
          store_id?: string | null
          store_name?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string | null
          status?: string | null
          store_id?: string | null
          store_name?: string | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      get_user_role: {
        Args: { _user_id: string }
        Returns: Database["public"]["Enums"]["app_role"]
      }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "customer"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "customer"],
    },
  },
} as const

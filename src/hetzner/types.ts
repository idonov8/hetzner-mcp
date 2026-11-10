// Subset of the Hetzner Cloud API response shapes this server reads.
// Reference: https://docs.hetzner.cloud/reference/cloud
// Fields that the API has removed or deprecated are optional.

export type Price = { net: string; gross: string };
export type Deprecation = { announced: string; unavailable_after: string } | null;

export interface Location {
  id: number;
  name: string;
  description?: string;
  country: string;
  city: string;
  network_zone?: string;
}

export interface ServerTypePrice {
  location: string;
  price_hourly?: Price;
  price_monthly: Price;
  included_traffic?: number;
  price_per_tb_traffic?: Price;
}

export interface ServerType {
  id: number;
  name: string;
  description: string;
  category?: string;
  cores: number;
  memory: number;
  disk: number;
  cpu_type: "shared" | "dedicated";
  architecture: string;
  storage_type?: string;
  prices?: ServerTypePrice[];
  /** Deprecated by Hetzner in favour of locations[].deprecation. */
  deprecated?: boolean;
  /** Deprecated by Hetzner in favour of locations[].deprecation. */
  deprecation?: Deprecation;
  locations?: Array<{ id: number; name: string; deprecation?: Deprecation }>;
}

export interface Image {
  id: number;
  type: "system" | "app" | "snapshot" | "backup";
  status: string;
  name: string | null;
  description: string;
  image_size: number | null;
  disk_size: number;
  created: string;
  created_from: { id: number; name: string } | null;
  bound_to: number | null;
  os_flavor: string;
  os_version?: string | null;
  architecture?: string;
  protection: { delete: boolean };
  labels?: Record<string, string>;
}

export interface Server {
  id: number;
  name: string;
  status: string;
  created: string;
  public_net: {
    ipv4: { id?: number; ip: string } | null;
    ipv6: { id?: number; ip: string } | null;
    floating_ips: number[];
    firewalls?: Array<{ id: number; status: string }>;
  };
  server_type: ServerType;
  /** Removed from the API on 2026-07-01; kept optional for older payloads. */
  datacenter?: { name: string } | null;
  location: Location;
  image: Image | null;
  backup_window: string | null;
  rescue_enabled: boolean;
  locked: boolean;
  protection: { delete: boolean; rebuild: boolean };
  labels: Record<string, string>;
  volumes: number[];
  primary_disk_size: number;
  included_traffic: number | null;
  outgoing_traffic: number | null;
  ingoing_traffic: number | null;
  load_balancers?: number[];
}

export interface FirewallRule {
  direction: "in" | "out";
  source_ips: string[];
  destination_ips: string[];
  protocol: "tcp" | "udp" | "icmp" | "esp" | "gre";
  port: string | null;
  description?: string | null;
}

export interface Firewall {
  id: number;
  name: string;
  rules: FirewallRule[];
  applied_to?: unknown[];
}

export interface Action {
  id: number;
  command: string;
  status: string;
  progress: number;
  started: string;
  finished: string | null;
  error: { code: string; message: string } | null;
  resources: Array<{ id: number; type: string }>;
}

export interface Volume {
  id: number;
  name: string;
  server: number | null;
  size: number;
  location: Location;
  status: string;
}

export interface PrimaryIp {
  id: number;
  name: string;
  ip: string;
  type: "ipv4" | "ipv6";
  assignee_id: number | null;
  assignee_type: string;
  location: Location;
}

export interface FloatingIp {
  id: number;
  name: string;
  ip: string;
  type: "ipv4" | "ipv6";
  server: number | null;
  home_location: Location;
}

export interface LoadBalancer {
  id: number;
  name: string;
  location: Location;
  load_balancer_type: { id: number; name: string; description?: string };
}

export interface Pricing {
  currency: string;
  vat_rate: string;
  image: { price_per_gb_month: Price };
  volume: { price_per_gb_month: Price };
  server_backup: { percentage: string };
  server_types: Array<{ id: number; name: string; prices: ServerTypePrice[] }>;
  load_balancer_types: Array<{ id: number; name: string; prices: Array<{ location: string; price_monthly: Price }> }>;
  primary_ips: Array<{ type: string; prices: Array<{ location: string; price_monthly: Price }> }>;
  floating_ips: Array<{ type: string; prices: Array<{ location: string; price_monthly: Price }> }>;
}

export interface MetricsResponse {
  metrics: {
    start: string;
    end: string;
    step: number;
    time_series: Record<string, { values: Array<[number, string]> }>;
  };
}

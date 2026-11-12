export type WorkOrderStatus = "open" | "in progress" | "closed";

export interface WorkOrder {
  id: number;                // invoice #
  status: WorkOrderStatus;
  assignedTo?: string;
  checkInAt: string;         // ISO
  lastName: string;
  firstName: string;
  phone?: string;
  total: number;
  balance: number;
  summary: string;
  // store removed – single-location deployment
  repairDate?: string | null;
}

// export type WorkOrderStore = 'Devine Street' | 'Forest Acres' | 'Online' | 'Other'; // unused

export interface WorkOrderItem {
  id: string;
  status: "pending" | "done";
  description: string;
  qty?: number;
  unitPrice?: number;
  repairTemplateId?: string | number;
  repairCategory?: string;
  repair?: string;
  parts?: number;
  labor?: number;
  internalCost?: number;
  markupPct?: number | string;
  distributor?: string;
  requiresOrder?: boolean;
  taxExempt?: boolean;
  supplierTaxRate?: number;
  orderStatus?: 'needed' | 'ordered' | 'received' | 'in_stock';
  stockSource?: "repairCategories" | "products" | string;
  inventoryProductId?: number;
  inventoryParentId?: number;
  stockConsumed?: boolean;
  trackStock?: boolean;
  partSource?: string;
  orderSourceUrl?: string;
  discountType?: 'percent' | 'amount';
  discountValue?: number;
}

export interface WorkOrderFull {
  id: number;
  status: WorkOrderStatus;
  assignedTo?: string | null;
  customerId: number;
  /** Snapshot of linked customer info for printouts, search, and cross-device display while customer lookups sync. */
  customerName?: string;
  customerPhone?: string;
  customerPhoneAlt?: string;
  customerEmail?: string;
  /** Optional linked retail sale (e.g., upsell at pickup) that should appear on the WO receipt. */
  addonSaleId?: number | null;
  checkInAt: string;
  repairCompletionDate?: string | null;
  checkoutDate?: string | null;

  productCategory: string;
  productDescription: string;
  problemInfo?: string;
  password?: string;
  diagnosticSelection?: { catalogId: string | number; label: string; amount: number } | null;
  durantFullTransfer?: boolean;
  patternSequence?: number[];
  model?: string;
  serial?: string;

  intakeSource?: string;

  // Parts ordering tracking (internal only; exclude from printouts)
  partsOrdered?: boolean;
  partsEstimatedDelivery?: string | null; // ISO date string (YYYY-MM-DD or full ISO)
  partsDates?: string;           // freeform dates/notes string
  partsOrderUrl?: string;        // order link or supplier URL
  partsTrackingUrl?: string;     // tracking link for shipment
  partsOrderDate?: string | null;   // ISO date (YYYY-MM-DD)
  partsEstDelivery?: string | null; // ISO date (YYYY-MM-DD)

  quotedPrice?: number;
  discount: number; // absolute discount applied to labor only
  discountType?: 'pct_5' | 'pct_10' | 'pct_15' | 'pct_20' | 'pct_25' | 'custom_pct' | 'custom_amt';
  discountPctValue?: number; // for custom_pct (e.g. 17 for 17%)
  discountCustomAmount?: number; // for custom_amt original input reference
  amountPaid: number;
  paymentType?: "Cash" | "Card" | "Apple Pay" | "Google Pay" | "Other" | string;
  payments?: Array<{ amount: number; paymentType: string; at: string }>;
  taxRate: number;

  laborCost: number;
  partCosts: number;

  totals: {
    subTotal: number;
    tax: number;
    total: number;
    remaining: number;
  };

  items: WorkOrderItem[];
  internalNotes?: string;

  droneChecklist?: DroneChecklist;
  dropoffAccessories?: DropoffAccessory[];
}

export interface Customer {
  id: number;
  firstName: string;
  middleInitial?: string;
  lastName: string;
  email?: string;
  phone?: string;
  phoneAlt?: string;
  declinedPhone?: boolean;
  declinedEmail?: boolean;
  zip?: string;
  notes?: string;
  // store removed – single-location deployment
  createdAt: string;
  updatedAt: string;
}

export interface Technician {
  id: string;
  firstName?: string;
  lastName?: string;
  nickname?: string;
  phone?: string;
  email?: string;
  active?: boolean;
}

export interface DroneChecklist {
  droneBody: boolean;
  remote: boolean;
  propellers: boolean; propellersQty: string;
  propellerGuards: boolean; propellerGuardsQty: string;
  batteries: boolean; batteriesQty: string;
  chargingDockCable: boolean;
  carryingCase: boolean;
  microSDCard: boolean; microSDCardQty: string;
  other: boolean; otherDescription: string;
}

export interface DropoffAccessory {
  id: string;
  description: string;
  qty: string;
}

export interface RepairItem {
  id: string;
  category: string;         // Device (e.g. "iPhone 15 Pro")
  repairCategory?: string;  // Service type (e.g. "Screen Repair", "Diagnostic")
  title: string;            // Product / Service name
  altDescription?: string;
  partCost: number;
  laborCost: number;
  // Internal cost for reporting/analytics only; not shown in work order UI
  internalCost?: number;
  markupPct?: number | string;
  taxExempt?: boolean;
  orderDate?: string;      // ISO
  estDelivery?: string;    // ISO
  partSource?: string;
  orderSourceUrl?: string;
  tutorialUrl?: string;
  tutorialMediaType?: 'youtube' | 'direct-video' | 'webpage';
  tutorialUpdatedAt?: string;
  type: "product" | "service";
  model?: string;
  compatibleDevices?: string[];
  // Inventory / stock tracking
  trackStock?: boolean;
  stockCount?: number;
  lowStockThreshold?: number;
  inventoryProductId?: number;
  inventoryParentId?: number;
  parentProductId?: number;
  isParentPart?: boolean;
  variantAttributes?: Record<string, string>;
  repairFamily?: string;
  serviceKey?: string;
  warrantyDays?: number;
  warrantyExcluded?: boolean;
}

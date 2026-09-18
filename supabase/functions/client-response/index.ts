import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type"};
const json=(body:Record<string,unknown>,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'content-type':'application/json;charset=utf-8','cache-control':'no-store'}});
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(byte=>byte.toString(16).padStart(2,'0')).join('');
const publicBase=()=>String(Deno.env.get('PUBLIC_APP_URL')||'https://rumsmokes.github.io/Gadgetboy-Command-Center').replace(/\/+$/,'');
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
 try{
  const url=new URL(req.url),token=url.searchParams.get('token')||'',requestedAction=(url.searchParams.get('action')||'view').toLowerCase();
  if(req.method==='GET'&&url.searchParams.get('format')!=='json')return Response.redirect(`${publicBase()}/client-response.html?token=${encodeURIComponent(token)}&action=${encodeURIComponent(requestedAction)}`,302);
  if(!token)return json({ok:false,error:'This response link is incomplete.'},400);
  const admin=createClient(Deno.env.get('SUPABASE_URL')!,Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const {data:tokenRow,error:tokenLookupError}=await admin.from('client_response_tokens').select('*').eq('token_hash',await hash(token)).maybeSingle();
  if(tokenLookupError)return json({ok:false,error:'This response link could not be verified. Please contact the shop.'},500);
  if(!tokenRow||new Date(tokenRow.expires_at).getTime()<Date.now())return json({ok:false,error:'This link has expired. Please contact the shop for a new response link.'},410);
  const {data:workOrder,error:workOrderError}=await admin.from('work_orders').select('id,shop_id,legacy_id,customer_id,product_category,product_description,model,serial,problem_info,repair_status,workflow_stage,scheduled_pickup_at').eq('id',tokenRow.work_order_id).maybeSingle();
  if(workOrderError||!workOrder)return json({ok:false,error:'The linked work order could not be loaded. Please contact the shop.'},500);
  const allowedActions=Array.isArray(tokenRow.allowed_actions)?tokenRow.allowed_actions.map(String):['question','add_information'];
  if(req.method==='GET')return json({ok:true,reference:`WO #${tokenRow.legacy_record_id}`,device:[workOrder.product_description,workOrder.model].filter(Boolean).join(' - ')||workOrder.product_category||'Your device',status:workOrder.repair_status||workOrder.workflow_stage||'In progress',problem:workOrder.problem_info||'',scheduledPickupAt:workOrder.scheduled_pickup_at||null,allowedActions,requestedAction:allowedActions.includes(requestedAction)?requestedAction:'view'});
  const contentType=req.headers.get('content-type')||'';
  const input=contentType.includes('application/json')?await req.json():Object.fromEntries((await req.formData()).entries());
  const selected=String(input.action||requestedAction).toLowerCase(),message=String(input.message||'').trim().slice(0,5000);
  if(!allowedActions.includes(selected))return json({ok:false,error:'This response is not available for this message.'},400);
  if(['question','request_pickup_change','add_information'].includes(selected)&&!message)return json({ok:false,error:'Please enter your message.'},400);
  const responseTypes:Record<string,string>={approve:'approved',decline:'declined',question:'question',confirm_pickup:'confirmed_pickup',request_pickup_change:'pickup_change_requested',add_information:'information'};
  const responseType=responseTypes[selected];if(!responseType)return json({ok:false,error:'Select a valid response.'},400);
  const conversationId=tokenRow.id;
  const {data:existing}=await admin.from('client_responses').select('id').eq('work_order_id',tokenRow.work_order_id).eq('conversation_id',conversationId).eq('response_type',responseType).eq('message',message||'').maybeSingle();
  if(!existing){const {error:insertError}=await admin.from('client_responses').insert({shop_id:tokenRow.shop_id,work_order_id:tokenRow.work_order_id,legacy_record_id:tokenRow.legacy_record_id,customer_id:workOrder.customer_id,response_type:responseType,message:message||null,conversation_id:conversationId});if(insertError)return json({ok:false,error:'Your response could not be saved. Please contact the shop.'},500);}
  const now=new Date().toISOString();
  const patch=selected==='approve'?{client_decision:'approved',client_decision_at:now,status_update:'Client Approved - Staff Acknowledgment Needed',status_updated_at:now}:selected==='decline'?{client_decision:'declined',client_decision_at:now,workflow_stage:'Pickup',repair_status:'Repair Declined - Awaiting Pickup',status_update:'Client Declined Repair',pickup_ready_at:now,status_updated_at:now}:selected==='confirm_pickup'?{status_update:'Client Confirmed Scheduled Pickup',status_updated_at:now}:{status_update:selected==='request_pickup_change'?'Client Requested Pickup Change':'Client Reply - Awaiting Response',status_updated_at:now};
  const {error:updateError}=await admin.from('work_orders').update(patch).eq('id',tokenRow.work_order_id);
  if(updateError)return json({ok:false,error:'Your response was received, but the work-order status could not be updated. Please contact the shop.'},500);
  return json({ok:true,responseType,message:`Thank you. Your ${responseType.replaceAll('_',' ')} response has been sent to GadgetBoy.`});
 }catch(error){return json({ok:false,error:error instanceof Error?error.message:String(error)},500)}
});

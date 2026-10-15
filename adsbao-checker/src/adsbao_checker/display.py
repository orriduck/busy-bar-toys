"""Small pixel aircraft and finite native entrance, using shared primitives."""
from PIL import Image,ImageDraw
from functools import lru_cache
from busybar_shared.graphics import tiny_text,fitted_text,to_xpm,clock_font,draw_clock
from busybar_shared.native import FPS,encode_sections,smooth,settle,split_flap_frame
from .proximity import MILE

JADE=(100,220,179)
ICON_ENTER_FRAMES=9
BRAND_HOLD_FRAMES=15
FLIP_FRAMES=12
ENTRANCE_FRAMES=ICON_ENTER_FRAMES+BRAND_HOLD_FRAMES+FLIP_FRAMES
ENTRANCE_SECONDS=ENTRANCE_FRAMES/FPS


@lru_cache(maxsize=64)
def title_image(title):
    width=max(1,round(clock_font().getlength(title)))
    image=Image.new('RGB',(width,7))
    draw_clock(ImageDraw.Draw(image),(0,0),title)
    if bounds:=image.getbbox():image=image.crop((0,0,bounds[2],7))
    if image.width>55:image=image.resize((55,7),Image.Resampling.BOX)
    return image


def aircraft_icon():
    image=Image.new('RGB',(16,14),'black');draw=ImageDraw.Draw(image)
    draw.polygon([(15,6),(11,5),(9,5),(5,0),(3,0),(5,5),(2,5),(1,3),
                  (0,3),(0,10),(1,10),(2,8),(5,8),(3,13),(5,13),(9,8),(11,8)],fill='white')
    draw.point((9,5),fill=JADE);draw.point((9,8),fill=JADE)
    return image


def render(nearby,*,progress=1,demo=False):
    plane=nearby.aircraft
    title=plane.identity[:8]
    heading=title_image(title)
    detail=f'{nearby.distance/MILE:.1f}MI'+(' '+plane.kind if plane.kind else '')
    detail=detail[:11]
    text_width=max(heading.width,len(detail)*4-1)
    left=(72-(16+1+text_width))//2;tx=left+17
    step=max(0,min(1,progress))*(ENTRANCE_FRAMES-1)
    entering=min(1,step/(ICON_ENTER_FRAMES-1))
    flip=max(0,min(1,(step-(ICON_ENTER_FRAMES+BRAND_HOLD_FRAMES-1))/FLIP_FRAMES))
    p=settle(entering)
    front=Image.new('RGB',(72,16),'black');draw=ImageDraw.Draw(front)
    brand=title_image('ADSBAO')
    if brand.width>text_width:brand=brand.resize((text_width,7),Image.Resampling.BOX)
    old,new=Image.new('RGB',(text_width,7)),Image.new('RGB',(text_width,7))
    old.paste(brand,(0,0));new.paste(heading,(0,0))
    flipped=split_flap_frame(old,new,flip).point(lambda value:round(value*p))
    front.paste(flipped,(tx,1))
    tiny_text(draw,(tx,10),detail,tuple(round(c*smooth(entering)) for c in JADE))
    x=round(-17+(left+17)*p)
    if p<1:
        for offset,level in ((2,.16),(4,.06)):
            trail=aircraft_icon().point(lambda v:round(v*level*p))
            front.paste(trail,(x-offset,1))
    icon=aircraft_icon().point(lambda v:round(v*p))
    front.paste(icon,(x,1))
    back=Image.new('RGB',(64,32),'black');draw=ImageDraw.Draw(back)
    fitted_text(draw,(1,0),'DEMO' if demo else 'ADSBao',62,9)
    fitted_text(draw,(1,11),title+' '+plane.kind,62,10)
    fitted_text(draw,(1,23),f'{nearby.distance/MILE:.1f} mi nearby',62,8)
    return front,back


def entrance_asset(nearby):
    return encode_sections((72,16),{'enter':[render(nearby,progress=i/(ENTRANCE_FRAMES-1))[0]
                                          for i in range(ENTRANCE_FRAMES)]})


def payload(nearby,*,demo=False,reduced=False,path=None):
    front,back=render(nearby,demo=demo)
    elements=[{'id':name,'type':'xpmbitmap','display':name,'x':0,'y':0,'timeout':15,
               'z_index':2 if name=='front' else 0,
               'data':to_xpm(image)} for name,image in (('front',front),('back',back))]
    strip={'id':'thinking','display':'front','x':0,'y':0,'z_index':1,'timeout':15}
    if reduced:strip.update(type='xpmbitmap',data=to_xpm(Image.new('RGB',(4,16),'black')))
    else:strip.update(type='animation',path='adsbao-blank.anim',loop=True,await_previous_end=True)
    elements.append(strip)
    if not reduced:
        elements.append({'id':'plane-view','type':'animation','display':'front','x':0,'y':0,
                         'z_index':30,'timeout':15,'path':path,'section':'enter',
                         'loop':False,'await_previous_end':False})
    return {'application_name':'ai-status','priority':50,'elements':elements}

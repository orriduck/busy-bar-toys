"""Small pixel aircraft and finite native entrance, using shared primitives."""
from PIL import Image,ImageDraw
from busybar_shared.graphics import tiny_text,fitted_text,to_xpm
from busybar_shared.native import encode_sections,smooth
from .proximity import MILE

JADE=(100,220,179)


def aircraft_icon():
    image=Image.new('RGB',(16,14),'black');draw=ImageDraw.Draw(image)
    draw.polygon([(15,6),(11,5),(9,5),(5,0),(3,0),(5,5),(2,5),(1,3),
                  (0,3),(0,10),(1,10),(2,8),(5,8),(3,13),(5,13),(9,8),(11,8)],fill='white')
    draw.point((9,5),fill=JADE);draw.point((9,8),fill=JADE)
    return image


def render(nearby,*,progress=1,demo=False):
    plane=nearby.aircraft
    title=plane.identity[:8]
    detail=f'{nearby.distance/MILE:.1f}MI'+(' '+plane.kind if plane.kind else '')
    detail=detail[:11]
    text_width=max(len(title),len(detail))*4-1
    left=(72-(16+1+text_width))//2;tx=left+17
    p=smooth(max(0,min(1,progress)))
    front=Image.new('RGB',(72,16),'black');draw=ImageDraw.Draw(front)
    tiny_text(draw,(tx,2),title,tuple(round(255*p) for _ in range(3)))
    tiny_text(draw,(tx,10),detail,tuple(round(c*p) for c in JADE))
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
    return encode_sections((72,16),{'enter':[render(nearby,progress=i/11)[0] for i in range(12)]})


def payload(nearby,*,demo=False,reduced=False,path=None):
    front,back=render(nearby,demo=demo)
    elements=[{'id':name,'type':'xpmbitmap','display':name,'x':0,'y':0,'timeout':15,
               'data':to_xpm(image)} for name,image in (('front',front),('back',back))]
    strip={'id':'thinking','display':'front','x':0,'y':0,'z_index':1,'timeout':15}
    if reduced:strip.update(type='xpmbitmap',data=to_xpm(Image.new('RGB',(4,16),'black')))
    else:strip.update(type='animation',path='adsbao-blank.anim',loop=True,await_previous_end=True)
    elements.append(strip)
    if not reduced:
        elements.append({'id':'plane-view','type':'animation','display':'front','x':0,'y':0,
                         'z_index':30,'timeout':15,'path':path,'loop':False,'await_previous_end':True})
    return {'application_name':'ai-status','priority':50,'elements':elements}
